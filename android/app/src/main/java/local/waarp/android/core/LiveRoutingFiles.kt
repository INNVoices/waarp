// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import local.waarp.android.i18n.localized

import local.waarp.android.data.MobileLivePlan
import local.waarp.android.data.MobileLiveRouting
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID
import org.json.JSONObject
import local.waarp.android.data.objects

/** Disk durability is not a reload ACK: every write must be observed inside the active core. */
internal object LiveRoutingFiles {
    /** Startup must prove watchers, not merely the initial parse of already-written files. */
    fun verifyInstalled(config: String, privateRoot: File, current: () -> Boolean) {
        val sets = JSONObject(config).optJSONObject("route")?.optJSONArray("rule_set")?.objects().orEmpty()
        if (sets.none { it.optString("tag") == MobileLiveRouting.ROUTE_GUARD }) return
        require(sets.size <= MobileLiveRouting.MAX_WATCHED_SETS)
        val root = privateRoot.canonicalPath + File.separator
        val witnesses = sets.map { set ->
            check(current()) { localized("LiveRoutingFiles.43b809ee4758", "Запуск отменён") }
            require(set.getString("type") == "local" && set.getString("format") == "source")
            val tag = set.getString("tag")
            val file = File(set.getString("path"))
            require(file.canonicalPath.startsWith(root) && file.name == MobileLiveRouting.fileName(tag) && file.length() <= 2_097_152)
            val plan = MobileLivePlan(file.parentFile!!.absolutePath, emptyList(), emptyList(), emptyMap(), emptyMap(), "", "")
            write(plan, tag, file.readText())
        }
        RoutingWitness.await(witnesses, current)
    }

    fun cleanupObsolete(plan: MobileLivePlan, keepDirectory: String?) {
        val directory = File(plan.directory)
        val parent = directory.parentFile ?: return
        if (parent.name != "live-routes") return
        parent.listFiles()?.filter { child ->
            child.isDirectory && child.name.matches(Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) &&
                child.absolutePath != directory.absolutePath && child.absolutePath != keepDirectory
        }?.forEach { it.deleteRecursively() }
    }

    fun initialize(plan: MobileLivePlan) {
        val directory = File(plan.directory)
        check(directory.isDirectory || directory.mkdirs()) { localized("LiveRoutingFiles.655467459fda", "Не удалось создать правила VPN") }
        directory.setReadable(false, false); directory.setWritable(false, false); directory.setExecutable(false, false)
        check(directory.setReadable(true, true) && directory.setWritable(true, true) && directory.setExecutable(true, true))
        plan.files.forEach { (tag, body) -> write(plan, tag, body) }
    }

    private fun write(plan: MobileLivePlan, tag: String, body: String): String {
        val witness = "${UUID.randomUUID().toString().replace("-", "")}.${MobileLiveRouting.CANARY_ZONE}"
        val destination = File(plan.directory, MobileLiveRouting.fileName(tag))
        val temporary = File.createTempFile(".route-", ".tmp", destination.parentFile)
        try {
            temporary.setReadable(false, false); temporary.setWritable(false, false)
            check(temporary.setReadable(true, true) && temporary.setWritable(true, true))
            temporary.outputStream().use { out ->
                out.write(MobileLiveRouting.withWitness(body, witness).toByteArray(Charsets.UTF_8)); out.fd.sync()
            }
            Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
        return witness
    }

    /** Callbacks are injected so ordering, rollback, OFF races and missing ACKs are testable. */
    suspend fun apply(before: MobileLivePlan, after: MobileLivePlan,
        current: () -> Boolean,
        acknowledge: suspend (List<String>) -> Unit,
        select: suspend (String, String) -> Unit,
        selected: () -> Map<String, String>,
        onUncertain: (Throwable) -> Unit,
        writer: (MobileLivePlan, String, String) -> String = ::write) {
        require(before.compatible(after)) { localized("LiveRoutingFiles.572e6508271b", "Новый профиль требует переподключения VPN") }
        val changed = after.files.filter { (tag, content) -> before.files[tag] != content }
        val switches = after.selections.filter { (tag, target) -> before.selections[tag] != target && selected()[tag] != target }
        if (changed.isEmpty() && switches.isEmpty()) return
        val guards = MobileLiveRouting.guards(before, after)
        val originalSelections = selected()
        var touched = false
        fun checkCurrent() { check(current()) { localized("LiveRoutingFiles.88350f088128", "Изменение маршрута отменено после выключения VPN") } }
        suspend fun publish(contents: Map<String, String>) {
            checkCurrent()
            val witnesses = contents.map { (tag, body) -> checkCurrent(); touched = true; writer(after, tag, body) }
            if (witnesses.isNotEmpty()) acknowledge(witnesses)
            checkCurrent()
        }
        suspend fun choose(targets: Map<String, String>) {
            for ((tag, target) in targets) {
                checkCurrent(); select(tag, target); checkCurrent()
                check(selected()[tag] == target) { localized("LiveRoutingFiles.e83ea07e0ea2", "Ядро не подтвердило новый путь") }
            }
        }
        try {
            publish(guards)
            publish(changed)
            choose(switches)
            publish(guards.mapValues { (_, _) -> MobileLiveRouting.body(emptyList()) })
        } catch (error: Exception) {
            // Explicit OFF always wins. Never write into, select, or restart its replacement.
            if (current() && touched) {
                val rollback = runCatching {
                    publish(guards)
                    publish(changed.mapValues { (tag, _) -> before.files.getValue(tag) })
                    choose(switches.mapValues { (tag, _) -> originalSelections[tag] ?: before.selections.getValue(tag) })
                    publish(guards.mapValues { (_, _) -> MobileLiveRouting.body(emptyList()) })
                }
                rollback.exceptionOrNull()?.let { failure ->
                    error.addSuppressed(failure)
                    // Unconfirmed rollback leaves temporary reject rules in place and
                    // requires an explicit reconnect; never report a successful live apply.
                    onUncertain(error)
                }
            }
            throw error
        }
    }
}
