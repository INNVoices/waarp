// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.core.RuntimeHttpResult
import java.security.MessageDigest

data class TransferObservation(val state: String, val bytes: Int = 0, val elapsedMs: Long? = null, val reason: String? = null)

/** Explicit bounded content test. Neither a HEAD response nor native byte counters are a payload proof. */
object TransferProof {
    // Immutable published ASCII text: JNI's string bridge is lossless for this exact fixture.
    const val URL = "https://www.rfc-editor.org/rfc/rfc6455.txt"
    const val BYTES = 162067
    const val SHA256 = "765775326aee0ecca9b04bde3fd1f52932d498e33e34e428bd61b8a24da0fa3b"
    const val MAX_BYTES = 196608
    const val TIMEOUT_MS = 10_000
    const val UPLOAD_BYTES = 65_536
    fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun download(reply: RuntimeHttpResult): TransferObservation = validateDownload(reply, BYTES, SHA256)
    internal fun validateDownload(reply: RuntimeHttpResult, expectedBytes: Int, expectedSha256: String): TransferObservation {
        if (reply.status != 200) return TransferObservation("fail", reason = "http")
        if (reply.truncated) return TransferObservation("fail", reason = "truncated")
        val bytes = reply.content.toByteArray(Charsets.UTF_8)
        if (bytes.size != expectedBytes) return TransferObservation("fail", bytes.size, reply.elapsedMs, "size")
        if (digest(bytes) != expectedSha256) return TransferObservation("fail", bytes.size, reply.elapsedMs, "content")
        return TransferObservation("pass", bytes.size, reply.elapsedMs)
    }
    fun uploadPayload(): ByteArray {
        val pattern = "waarp-payload-v1\n"
        return ByteArray(UPLOAD_BYTES) { pattern[it % pattern.length].code.toByte() }
    }
    fun uploadAcknowledged(status: Int, body: String, payload: ByteArray, elapsedMs: Long): TransferObservation {
        if (status != 200 || body.toByteArray(Charsets.UTF_8).size > 4096) return TransferObservation("fail", reason = "http")
        return runCatching {
            val reply = org.json.JSONObject(body)
            require(reply.getLong("bytes") == payload.size.toLong() && reply.getString("sha256") == digest(payload))
            TransferObservation("pass", payload.size, elapsedMs)
        }.getOrElse { TransferObservation("fail", reason = "acknowledgement") }
    }
}
