// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import android.content.Context
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import local.waarp.android.BuildConfig
import local.waarp.android.core.RuntimeLog
import local.waarp.android.core.RuntimeStatus
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File

/** Small offline evidence, allowlisted before disk and again before sharing. Never stores raw native text. */
class LastSessionEvidence(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "last-vpn-session.json"))
    private val mutex = Mutex()
    private val _report = MutableStateFlow<String?>(null)
    val report = _report.asStateFlow()
    private var lastPhase: String? = null
    private var lastWrite = 0L
    private var lastTransfer: JSONObject? = null

    suspend fun load() = withContext(Dispatchers.IO) { mutex.withLock {
        _report.value = runCatching { val events = readEvents(); document(events, lastTransfer).toString(1) }
            .getOrElse { obj("schema" to 1, "available" to false).toString() }
    } }

    suspend fun record(status: RuntimeStatus, logs: List<RuntimeLog>) = withContext(Dispatchers.IO) {
        mutex.withLock {
            val now = System.currentTimeMillis()
            if (lastPhase == status.phase.name && now - lastWrite in 0 until 15_000) return@withLock
            // A fresh process must not erase the previous session with its initial OFF observation.
            if (lastPhase == null && status.phase.name == "OFF") { lastPhase = "OFF"; return@withLock }
            val event = snapshot(status, logs, now)
            val saved = runCatching {
                val events = (readEvents() + event).takeLast(MAX_EVENTS)
                persist(events)
            }.isSuccess
            if (!saved) _report.value = obj("schema" to 1, "available" to false, "writeFailed" to true).toString()
            lastWrite = now; lastPhase = status.phase.name
        }
    }

    suspend fun recordTransfer(at: Long, download: TransferObservation, upload: TransferObservation) = withContext(Dispatchers.IO) {
        mutex.withLock {
            runCatching {
                val events = readEvents()
                fun result(value: TransferObservation) = obj("state" to value.state, "bytes" to value.bytes,
                    "elapsedMs" to value.elapsedMs, "reason" to value.reason)
                lastTransfer = safeTransfer(obj("at" to at, "download" to result(download), "upload" to result(upload)))
                persist(events)
            }.onFailure { _report.value = obj("schema" to 1, "available" to false, "writeFailed" to true).toString() }
            Unit
        }
    }

    private fun persist(events: List<JSONObject>) {
        val document = document(events, lastTransfer)
        val bytes = document.toString().toByteArray(Charsets.UTF_8); check(bytes.size <= MAX_BYTES)
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
        _report.value = document.toString(1)
    }

    suspend fun clear() = withContext(Dispatchers.IO) { mutex.withLock {
        file.delete()
        check(!file.baseFile.exists()) { "Не удалось удалить сохранённую диагностику" }
        lastTransfer = null
        _report.value = document(emptyList()).toString(1)
    } }

    private fun readEvents(): List<JSONObject> {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return emptyList()
        val bytes = file.openRead().use { input ->
            val output = ByteArrayOutputStream(); val buffer = ByteArray(4096)
            while (true) {
                val count = input.read(buffer); if (count == -1) break
                require(output.size() + count <= MAX_BYTES); output.write(buffer, 0, count)
            }; output.toByteArray()
        }
        val root = JSONObject(String(bytes, Charsets.UTF_8)); require(root.getInt("schema") == 1)
        lastTransfer = root.optJSONObject("transfer")?.let(::safeTransfer)
        val events = root.getJSONArray("events"); require(events.length() <= MAX_EVENTS)
        return events.objects().map(::safeEvent)
    }

    companion object {
        const val MAX_EVENTS = 48
        const val MAX_BYTES = 65_536
        private val phases = setOf("OFF", "STARTING", "ON", "STOPPING", "ERROR")
        private val categories = setOf("none", "timeout", "dns", "tls", "socket", "permission", "handshake", "unknown")
        fun errorClass(message: String?): String = when {
            message.isNullOrBlank() -> "none"
            Regex("timeout|deadline|тайм|время ожидания", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "timeout"
            message.contains("dns", true) -> "dns"
            Regex("tls|certificate|сертификат", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "tls"
            Regex("socket|network is unreachable|connection reset", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "socket"
            Regex("permission|разреш|отозва", RegexOption.IGNORE_CASE).containsMatchIn(message) -> "permission"
            message.contains("handshake", true) -> "handshake"
            else -> "unknown"
        }
        fun snapshot(status: RuntimeStatus, logs: List<RuntimeLog>, at: Long): JSONObject = safeEvent(obj(
            "at" to at, "phase" to status.phase.name, "startedAt" to status.startedAt,
            "uploadBytes" to status.uploadBytes, "downloadBytes" to status.downloadBytes,
            "connections" to status.connectionCount, "errorClass" to errorClass(status.message),
            "errors" to logs.takeLast(500).filter { it.level >= 3 }.groupingBy { errorClass(it.message) }.eachCount()))
        fun safeEvent(j: JSONObject): JSONObject = obj(
            "at" to j.optLong("at").coerceAtLeast(0),
            "phase" to j.optString("phase").takeIf { it in phases }.orEmpty(),
            "startedAt" to j.optLong("startedAt").coerceAtLeast(0),
            "uploadBytes" to j.optLong("uploadBytes").coerceAtLeast(0),
            "downloadBytes" to j.optLong("downloadBytes").coerceAtLeast(0),
            "connections" to j.optInt("connections").coerceIn(0, 1_000_000),
            "errorClass" to j.optString("errorClass").takeIf { it in categories }.orEmpty(),
            "errors" to categories.associateWith { j.optJSONObject("errors")?.optInt(it)?.coerceIn(0, 500) ?: 0 })
        fun safeTransfer(raw: JSONObject): JSONObject {
            fun direction(name: String): JSONObject {
                val value = raw.optJSONObject(name) ?: JSONObject()
                val reasons = setOf("http", "truncated", "size", "content", "acknowledgement", "network", "no_endpoint", "service_path")
                return obj("state" to value.optString("state").takeIf { it in setOf("pass", "fail", "not_measured") }.orEmpty(),
                    "bytes" to value.optInt("bytes").coerceIn(0, TransferProof.MAX_BYTES),
                    "elapsedMs" to value.optLong("elapsedMs").coerceIn(0, 60_000),
                    "reason" to value.optString("reason").takeIf { it in reasons })
            }
            return obj("at" to raw.optLong("at").coerceAtLeast(0), "target" to "rfc6455",
                "download" to direction("download"), "upload" to direction("upload"))
        }
        private fun document(events: List<JSONObject>, transfer: JSONObject? = null) = obj("schema" to 1, "available" to true,
            "app" to BuildConfig.VERSION_NAME, "engine" to BuildConfig.ENGINE_VERSION,
            "events" to events.map(::safeEvent), "transfer" to transfer?.let(::safeTransfer))
    }
}
