// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import local.waarp.android.core.RuntimePhase
import local.waarp.android.core.RuntimeProbeResult
import local.waarp.android.core.VpnController
import java.util.concurrent.atomic.AtomicLong

/** Process-level owner: Always-on, measurements and failover continue without an Activity or ViewModel. */
class MobileRepository(private val context: Context, val controller: VpnController) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = ProfileStore(context)
    private val edits = Mutex()
    private val probes = Mutex()
    private val generation = AtomicLong()
    private val _data = MutableStateFlow<AppData?>(null)
    val data = _data.asStateFlow()
    private val _loadError = MutableStateFlow<String?>(null)
    val loadError = _loadError.asStateFlow()
    private val _requestedOpen = MutableStateFlow(false)
    val requestedOpen = _requestedOpen.asStateFlow()
    private val _applying = MutableStateFlow(false)
    val applying = _applying.asStateFlow()
    private val _compiled = MutableStateFlow<CompiledConfiguration?>(null)
    val compiled = _compiled.asStateFlow()
    private val _health = MutableStateFlow<Map<String, ProbeHealth>>(emptyMap())
    val health = _health.asStateFlow()
    private val _history = MutableStateFlow<Map<String, List<Double?>>>(emptyMap())
    val history = _history.asStateFlow()
    private val selectionMemory = mutableMapOf<String, SelectionMemory>()
    private var cursor = 0

    init {
        controller.setConfigurationProvider {
            // This reads current encrypted state after process death; no stale cached core config can resurrect a deleted profile.
            edits.withLock {
                val current = store.read()
                _data.value = current; _loadError.value = null
                val result = compile(current)
                _compiled.value = result
                result.json
            }
        }
        scope.launch { reload() }
        scope.launch { data.filterNotNull().map { it.settings.notifications }.distinctUntilChanged().collect { controller.setEventNotificationsEnabled(it) } }
        scope.launch {
            var previous = RuntimePhase.OFF
            controller.status.map { it.phase }.distinctUntilChanged().collect { phase ->
                if (phase == RuntimePhase.ON || phase == RuntimePhase.STARTING) _requestedOpen.value = true
                if (!_applying.value && phase in setOf(RuntimePhase.OFF, RuntimePhase.ERROR) && previous != RuntimePhase.OFF) {
                    generation.incrementAndGet(); _requestedOpen.value = false
                }
                previous = phase
            }
        }
        scope.launch {
            controller.status.map { it.phase }.distinctUntilChanged().collectLatest { phase ->
                if (phase == RuntimePhase.ON) {
                    delay(1200)
                    while (true) {
                        try { probe() } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { /* State remains unmeasured if the core is unavailable. */ }
                        delay(15_000)
                    }
                }
            }
        }
    }

    suspend fun reload() = edits.withLock {
        try { _data.value = store.read(); _loadError.value = null }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { _loadError.value = "Не удалось открыть защищённое хранилище. Файл сохранён; разблокируйте устройство и повторите попытку." }
    }
    suspend fun ready(): AppData {
        _loadError.value?.let { error(it) }
        return _data.value ?: withTimeout(15_000) {
            combine(data, loadError) { value, error -> error?.let { throw IllegalStateException(it) }; value }.filterNotNull().first()
        }
    }
    private fun compile(value: AppData): CompiledConfiguration = RoutingCompiler.compile(value, context.packageName,
        controller.groups.value.find { it.tag == "grp-$AUTO" }?.selected?.removePrefix("p-"))

    fun requestConnect(): Long {
        val token = generation.incrementAndGet(); _requestedOpen.value = true; return token
    }
    fun intentGeneration(): Long = generation.get()
    fun consentCancelled(token: Long) {
        if (generation.compareAndSet(token, token + 1)) _requestedOpen.value = false
    }
    suspend fun completeConnect(token: Long) {
      ready()
      edits.withLock {
        if (generation.get() != token || !_requestedOpen.value) return@withLock
        try {
            val value = _data.value ?: error("Хранилище не готово"); val compiled = withContext(Dispatchers.Default) { compile(value) }
            controller.validateConfig(compiled.json)
            if (generation.get() != token || !_requestedOpen.value) return@withLock
            _compiled.value = compiled; controller.start(compiled.json)
        } catch (error: Exception) {
            if (generation.compareAndSet(token, token + 1)) _requestedOpen.value = false
            throw error
        }
      }
    }
    fun disconnect() {
        generation.incrementAndGet(); _requestedOpen.value = false; controller.stop()
    }

    suspend fun edit(transform: (AppData) -> AppData): AppData {
      ready()
      return edits.withLock {
        val before = _data.value ?: error("Хранилище не готово"); val after = transform(before).copy(revision = before.revision + 1).checked()
        val next = withContext(Dispatchers.Default) { compile(after) }
        controller.validateConfig(next.json)
        val token = generation.get()
        val phase = controller.status.value.phase
        val nativeGeneration = controller.sessionGeneration()
        val active = phase in setOf(RuntimePhase.ON, RuntimePhase.STARTING)
        val requiresRestart = active && next.json != _compiled.value?.json
        _applying.value = true
        var committed = false
        var pausedGeneration: Long? = null
        try {
            withContext(NonCancellable) {
                // Once a runtime update begins, leaving the screen cannot strand
                // the old data with a stopped VPN between cleanup and disk commit.
                if (requiresRestart) {
                    pausedGeneration = controller.pauseForUpdate(nativeGeneration)
                    if (pausedGeneration != null) withTimeout(20_000) {
                        controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR }
                    }
                }
                store.write(after)
                _data.value = after; _loadError.value = null; _compiled.value = next
                committed = true
                val beforeById = before.profiles.associateBy { it.id }
                val valid = after.profiles.filter { !it.revoked && !it.subscriptionMissing && beforeById[it.id]?.config == it.config }.map { it.id }.toSet()
                _health.update { map -> map.filterKeys { it in valid } }
                _history.update { map -> map.filterKeys { it in valid } }
                selectionMemory.keys.retainAll(after.groups.map { it.id }.toSet() + AUTO)
                if (requiresRestart) selectionMemory.clear()
                val paused = pausedGeneration
                if (paused != null && _requestedOpen.value && generation.get() == token) {
                    // A notification OFF/revoke changes the native epoch even
                    // while phase observers are suppressed by _applying.
                    try { controller.resumeAfterUpdate(next.json, paused) }
                    catch (error: Exception) {
                        _requestedOpen.value = false; generation.incrementAndGet()
                        throw IllegalStateException("Изменения сохранены, но VPN не перезапустился. Повторите подключение.", error)
                    }
                }
                after
            }
        } catch (error: Exception) {
            pausedGeneration?.let(controller::abandonUpdate)
            if (requiresRestart && !committed) { _requestedOpen.value = false; generation.incrementAndGet() }
            throw error
        } finally {
            _applying.value = false
            if (phase in setOf(RuntimePhase.ON, RuntimePhase.STARTING, RuntimePhase.STOPPING) &&
                !controller.hasStartRequest() && generation.compareAndSet(token, token + 1)) {
                _requestedOpen.value = false
            }
        }
      }
    }

    suspend fun validateProfiles(profiles: List<TunnelProfile>) {
        require(profiles.isNotEmpty()) { "Нет профилей для импорта" }
        // libbox CheckConfig constructs and closes a real box. WireGuard's
        // constructor allocates a gVisor stack even before Start, so a large
        // subscription must not instantiate its entire library in one box.
        // Every batch succeeds before the caller can commit any imported data.
        for (batch in profiles.chunked(8)) {
            val checker = withContext(Dispatchers.Default) {
                RoutingCompiler.compile(AppData(profiles = batch), context.packageName, checkerProfiles = batch)
            }
            controller.validateConfig(checker.json, requireTun = false)
        }
    }

    suspend fun probe(extra: List<TunnelProfile>? = null, url: String? = null): List<RuntimeProbeResult> = probes.withLock {
        val value = ready()
        val token = generation.get()
        val sessionGeneration = controller.sessionGeneration()
        val phase = controller.status.value.phase
        check(phase !in setOf(RuntimePhase.STARTING, RuntimePhase.STOPPING) && !_applying.value) { "Дождитесь завершения переключения VPN" }
        val active = phase == RuntimePhase.ON
        val available = (extra ?: value.profiles).filterNot { it.revoked || it.subscriptionMissing }
        val eligible = if (active) available.filter { it.id in _compiled.value?.loadedProfiles.orEmpty() } else available
        if (eligible.isEmpty()) return@withLock emptyList()
        val selected = controller.groups.value.map { it.selected.removePrefix("p-") }
        val sample = SelectionPolicy.sample(eligible.map { it.id }, selected, cursor)
        cursor = sample.second
        val profiles = sample.first.mapNotNull { id -> eligible.find { it.id == id } }
        val byTag = profiles.associateBy { "p-${it.id}" }
        fun currentSession() = generation.get() == token && _data.value?.revision == value.revision &&
            controller.isSessionGeneration(sessionGeneration) && controller.status.value.phase == phase && !_applying.value
        suspend fun measure(tags: List<String>, target: String): List<RuntimeProbeResult> {
            if (!currentSession()) return emptyList()
            return if (active) tags.map { tag ->
                if (!currentSession()) return emptyList()
                try { RuntimeProbeResult(tag, controller.urlTest(tag, target, expectedGeneration = sessionGeneration), null, System.currentTimeMillis()) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { RuntimeProbeResult(tag, null, "Проверка не прошла", System.currentTimeMillis()) }
            } else {
                val selectedProfiles = tags.mapNotNull(byTag::get)
                val checker = withContext(Dispatchers.Default) { RoutingCompiler.compile(value, context.packageName, checkerProfiles = selectedProfiles) }
                if (!currentSession()) return emptyList()
                controller.checkOutbounds(checker.json, tags, target)
            }
        }
        val healthCheck = url == null
        val results = HealthProbe.run(byTag.keys.toList(), url ?: HealthProbe.PRIMARY, healthCheck, ::currentSession, ::measure)
        if (!currentSession()) return@withLock emptyList()
        if (extra == null && healthCheck) {
            _health.update { before -> before.toMutableMap().apply {
                results.forEach { result -> val id = result.tag.removePrefix("p-"); put(id, (get(id) ?: ProbeHealth()).measured(result.delayMs, result.checkedAt)) }
            } }
            _history.update { before -> before.toMutableMap().apply {
                results.forEach { result -> val id = result.tag.removePrefix("p-"); put(id, (get(id).orEmpty() + result.delayMs?.toDouble()).takeLast(64)) }
            } }
            if (active) selectPaths(token, value.revision, sessionGeneration, results.map { it.tag.removePrefix("p-") }.toSet())
        }
        results
    }

    private suspend fun selectPaths(token: Long, revision: Long, sessionGeneration: Long, measured: Set<String>) = edits.withLock {
        fun currentSession() = generation.get() == token && _data.value?.revision == revision &&
            controller.isSessionGeneration(sessionGeneration) && controller.status.value.phase == RuntimePhase.ON
        if (!currentSession()) return@withLock
        val compiled = _compiled.value ?: return@withLock
        val health = _health.value
        val activeTags = controller.activeFlowTags.value
        for (group in compiled.groups) {
            if (!currentSession()) return@withLock
            val native = controller.groups.value.find { it.tag == "grp-${group.id}" } ?: continue
            val current = native.selected.removePrefix("p-")
            val decision = SelectionPolicy.select(group, current, health, selectionMemory[group.id] ?: SelectionMemory(),
                activeTags == null || native.tag in activeTags, measured)
            selectionMemory[group.id] = decision.memory
            if (decision.next != current && decision.next in group.members) controller.selectOutbound(native.tag, "p-${decision.next}", expectedGeneration = sessionGeneration)
        }
        fun effective(via: String): String = if (via.startsWith("g-")) controller.groups.value.find { it.tag == "grp-$via" }?.selected?.removePrefix("p-").orEmpty() else via
        fun tag(via: String) = if (via.startsWith("g-")) "grp-$via" else "p-$via"
        for ((selector, pair) in compiled.selectorTargets) {
            if (!currentSession()) return@withLock
            val native = controller.groups.value.find { it.tag == selector } ?: continue
            val primary = health[effective(pair.first)]; val fallback = health[effective(pair.second)]
            val next = when {
                primary?.down == true && fallback?.healthy == true && effective(pair.second) in measured -> tag(pair.second)
                primary?.healthy == true && effective(pair.first) in measured && native.selected != tag(pair.first) && activeTags != null && selector !in activeTags -> tag(pair.first)
                else -> native.selected
            }
            if (next != native.selected) controller.selectOutbound(selector, next, expectedGeneration = sessionGeneration)
        }
    }
}
