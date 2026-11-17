#!/usr/bin/env python3
"""One-shot exact-source maintenance patch. No refs are moved by this script."""
from pathlib import Path
import json
pending = {}
def read(path):
    return pending.get(path, Path(path).read_text(encoding='utf-8'))
def replace(path, old, new, count=1):
    text = read(path)
    if text.count(old) != count:
        raise RuntimeError(f'{path}: expected {count} exact matches, got {text.count(old)}')
    pending[path] = text.replace(old, new)
def add(path, content):
    if Path(path).exists() or path in pending:
        raise RuntimeError(f'Refuse to overwrite unreviewed new path: {path}')
    pending[path] = content

add('src/shared/routing-edit.ts', '''import type { Settings } from './types'

/** Metadata and disabled records do not participate in the active routing plan.
 * Preserve the order of active rules and group members: both affect precedence.
 * This is an equality fast path, not a substitute for the engine's live apply. */
export function sameEffectiveRouting(before: Settings, after: Settings): boolean {
  const signature = (s: Settings) => {
    const routes = s.routes.filter(r => r.on)
    const referenced = new Set([s.rest, ...routes.flatMap(r => [r.via, r.fallback].filter((v): v is string => !!v))])
    return JSON.stringify({
      rest: s.rest, ruDirect: s.ruDirect, dnsAll: s.dnsAll, lanDirect: s.lanDirect,
      routes: routes.map(({ name: _name, ...rule }) => rule),
      groups: s.groups.filter(g => referenced.has(g.id))
        .map(({ name: _name, ...group }) => group).sort((a, b) => a.id.localeCompare(b.id))
    })
  }
  return signature(before) === signature(after)
}
''')
replace('src/main/apply.ts', "import type { Settings } from '../shared/types'", "import type { Settings } from '../shared/types'\nimport { sameEffectiveRouting } from '../shared/routing-edit'")
replace('src/main/apply.ts', '      // B2: a pick the running core already serves is a selector switch; the periodic watch still guards the session', '''      // A deleted disabled route or a renamed card cannot stop a working VPN.
      // The periodic safety watch still checks the actual environment independently.
      if (d.phase() === 'on' && sameEffectiveRouting(previous, next)) return { saved: true, applied: true, running }
      // B2: a pick the running core already serves is a selector switch; the periodic watch still guards the session''')
replace('src/main/index.ts', "import { compilePlan, requiresCore } from '../shared/plan'", "import { compilePlan, requiresCore } from '../shared/plan'\nimport { sameEffectiveRouting } from '../shared/routing-edit'")
replace('src/main/index.ts', '    if (routing) {\n      const revision = master.revision', '''    if (routing) {
      // Do not send an inert library edit through adapter scans or native teardown.
      if (master.open && engine.status.phase === 'on' && sameEffectiveRouting(previous, store.settings)) {
        updateTray(); send('snapshot', snapshot()); return { ...snapshot(), saved: true }
      }
      const revision = master.revision''')
repo = 'android/app/src/main/java/local/waarp/android/data/MobileRepository.kt'
replace(repo, '''    private fun compile(value: AppData): CompiledConfiguration = RoutingCompiler.compile(value, context.packageName,
        controller.groups.value.find { it.tag == "grp-$AUTO" }?.selected?.removePrefix("p-"))''', '''    private fun currentAuto(): String? =
        controller.groups.value.find { it.tag == "grp-$AUTO" }?.selected?.removePrefix("p-")
    private fun compile(value: AppData, selectedAuto: String? = currentAuto()): CompiledConfiguration =
        RoutingCompiler.compile(value, context.packageName, selectedAuto)''')
replace(repo, 'if (!_applying.value && phase in setOf(RuntimePhase.OFF, RuntimePhase.ERROR) && previous != RuntimePhase.OFF)', '''if (!_applying.value && !controller.hasStartRequest() &&
                    phase in setOf(RuntimePhase.OFF, RuntimePhase.ERROR) && previous != RuntimePhase.OFF)''')
replace(repo, '        val (after, next) = withContext(Dispatchers.Default) {', '''        val selectedAuto = currentAuto()
        val (after, next, runtimeChanged) = withContext(Dispatchers.Default) {''')
replace(repo, '''            prepared to compile(prepared)
        }
        controller.validateConfig(next.json)''', '''            val baseline = compile(before, selectedAuto)
            val candidate = compile(prepared, selectedAuto)
            Triple(prepared, candidate, baseline.json != candidate.json)
        }
        if (runtimeChanged || _compiled.value == null) controller.validateConfig(next.json)''')
replace(repo, '        val requiresRestart = active && next.json != _compiled.value?.json', '        val requiresRestart = active && runtimeChanged')
replace(repo, '''                        controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR }
                    }
                }
                store.write(after)''', '''                        val stopped = controller.status.first { it.phase == RuntimePhase.OFF || it.phase == RuntimePhase.ERROR }
                        check(stopped.phase == RuntimePhase.OFF) { "Не удалось завершить предыдущую сессию VPN. Изменения не сохранены." }
                    }
                }
                store.write(after)''')
replace(repo, '''                    try { controller.resumeAfterUpdate(next.json, paused) }
                    catch (error: Exception) {
                        _requestedOpen.value = false; generation.incrementAndGet()''', '''                    try {
                        val resumed = controller.resumeAfterUpdate(next.json, paused)
                        // A newer OFF/ON may supersede this edit. An unchanged idle generation
                        // refusing its own resume is not a successful runtime apply.
                        check(resumed || !controller.isSessionGeneration(paused)) { "VPN не принял обновлённую конфигурацию" }
                    }
                    catch (error: Exception) {
                        if (generation.compareAndSet(token, token + 1)) _requestedOpen.value = false''')
replace(repo, '            if (requiresRestart && !committed) { _requestedOpen.value = false; generation.incrementAndGet() }', '            if (requiresRestart && !committed && generation.compareAndSet(token, token + 1)) _requestedOpen.value = false')
add('android/app/src/main/java/local/waarp/android/core/ServiceStopPolicy.kt', '''// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

/** A route update may close the core temporarily, but still owns the foreground service.
 * Only a fully settled user/system stop may tear down the Android service. */
internal fun mayFinishVpnService(
    restoring: Boolean, wanted: Boolean, pausedForUpdate: Boolean, stopped: Boolean,
): Boolean = !restoring && !wanted && !pausedForUpdate && stopped
''')
service = 'android/app/src/main/java/local/waarp/android/service/WaarpVpnService.kt'
replace(service, 'import local.waarp.android.core.VpnController', 'import local.waarp.android.core.VpnController\nimport local.waarp.android.core.mayFinishVpnService')
replace(service, '''    private fun settledOff(): Boolean = restoringGeneration == null && !RuntimeState.wanted() &&
        RuntimeState.status.value.phase in setOf(RuntimePhase.OFF, RuntimePhase.ERROR)''', '''    private fun settledOff(): Boolean = mayFinishVpnService(
        restoring = restoringGeneration != null,
        wanted = RuntimeState.wanted(),
        pausedForUpdate = RuntimeState.isPausedForUpdate(),
        stopped = RuntimeState.status.value.phase in setOf(RuntimePhase.OFF, RuntimePhase.ERROR),
    )''')
imp = 'android/app/src/main/java/local/waarp/android/data/ProfileImporter.kt'
replace(imp, 'setOf("chrome", "firefox", "safari", "edge", "ios", "android", "360", "qq", "random", "randomized")', 'setOf("chrome", "chrome_155", "firefox", "safari", "edge", "ios", "android", "360", "qq", "random", "randomized")')
replace('src/main/tune.ts', 'for (const mtu of [1200, 1360]) if (mtu !== (p.mtu ?? 1280))', 'for (const mtu of [1280, 1360]) if (mtu < (p.mtu ?? 1280))')
ui = 'android/app/src/main/java/local/waarp/android/ui/UiComponents.kt'
replace(ui, 'import androidx.compose.runtime.Composable', 'import androidx.compose.runtime.Composable\nimport androidx.compose.runtime.staticCompositionLocalOf')
replace(ui, 'internal class UiOperation(private val scope: CoroutineScope) {', '''internal val LocalOperationMessage = staticCompositionLocalOf<(String) -> Unit> { {} }

internal class UiOperation(private val scope: CoroutineScope, private val showMessage: (String) -> Unit = {}) {''')
replace(ui, '''                    message = result.message
                    if (completeForm) completions++''', '''                    message = result.message
                    result.message?.takeIf { it.isNotBlank() }?.let(showMessage)
                    if (completeForm) completions++''')
replace(ui, '    return remember(scope) { UiOperation(scope) }', '''    val showMessage = LocalOperationMessage.current
    return remember(scope, showMessage) { UiOperation(scope, showMessage) }''')
replace(ui, '    operation.message?.let { InlineMessage(it) }', '''    // Success goes to the root snackbar and cannot grow the card.
    // Blocking errors remain inline, next to the relevant control.''')
app = 'android/app/src/main/java/local/waarp/android/ui/WaarpApp.kt'
replace(app, 'import java.util.UUID', 'import java.util.UUID\nimport kotlinx.coroutines.launch')
replace(app, '        val snackbar = remember { SnackbarHostState() }', '''        val snackbar = remember { SnackbarHostState() }
        val feedbackScope = rememberCoroutineScope()
        val showOperationMessage: (String) -> Unit = remember(snackbar, feedbackScope) {
            { text ->
                feedbackScope.launch {
                    snackbar.showSnackbar(text, withDismissAction = true, duration = SnackbarDuration.Short)
                }
                Unit
            }
        }''')
replace(app, '        BoxWithConstraints(Modifier.fillMaxSize()) {', '''        CompositionLocalProvider(LocalOperationMessage provides showOperationMessage) {
        BoxWithConstraints(Modifier.fillMaxSize()) {''')
replace(app, '''    }
}

@Composable
private fun LoadingState''', '''        }
    }
}

@Composable
private fun LoadingState''')
add('test/routing-edit.check.ts', '''import assert from 'node:assert/strict'
import { DEFAULTS } from '../src/main/store-core'
import { sameEffectiveRouting } from '../src/shared/routing-edit'
import { createApply } from '../src/main/apply'
import type { Settings } from '../src/shared/types'

const base: Settings = { ...DEFAULTS, rest: 'personal', routes: [
  { id: 'a', kind: 'custom', name: 'A', value: 'example.org', via: 'personal', on: true },
  { id: 'unused', kind: 'custom', name: 'Unused', value: 'example.net', via: 'other', on: false }
] }
const removed = { ...base, routes: base.routes.slice(0, 1) }
assert(sameEffectiveRouting(base, removed), 'delete disabled route is inert')
assert(sameEffectiveRouting(base, { ...base, routes: base.routes.map(r => ({ ...r, name: 'renamed' })) }))
assert(!sameEffectiveRouting(base, { ...base, routes: [] }), 'deleting active route is effective')
assert(!sameEffectiveRouting(base, { ...base, rest: 'other' }))
assert(!sameEffectiveRouting(base, { ...base, dnsAll: !base.dnsAll }))
assert(!sameEffectiveRouting(base, { ...base, lanDirect: !base.lanDirect }))
assert(!sameEffectiveRouting(base, { ...base, routes: base.routes.map(r => ({ ...r, on: true })) }))
assert(!sameEffectiveRouting(base, { ...base, routes: base.routes.map(r => r.on ? { ...r, dpi: true } : r) }))
const two = { ...base, routes: [...base.routes, { ...base.routes[0], id: 'b', via: 'other' }] }
assert(!sameEffectiveRouting(two, { ...two, routes: [...two.routes].reverse() }), 'active rule precedence retained')

async function main() {
  for (const open of [true, false]) {
    let settings = base, saves = 0, touches = 0
    const apply = createApply({
      get: () => settings, set: s => { settings = s }, save: () => { saves++ },
      phase: () => 'on', open: () => open, revision: () => 1,
      blocked: async () => { touches++; return true },
      demandsTunnel: () => true,
      live: async () => { touches++; return false },
      start: async () => { touches++ }, stop: async () => { touches++ }, changed: () => {}
    })
    const result = await apply(removed)
    assert.equal(result.saved, true)
    assert.equal(result.applied, open)
    assert.equal(saves, 1)
    assert.equal(touches, 0, 'inert deletion must not scan, restart or stop')
  }
  console.log('routing-edit.check: policy and behavioral deletion cases PASS')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
''')
add('android/app/src/test/java/local/waarp/android/core/ServiceStopPolicyTest.kt', '''// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import org.junit.Assert.*
import org.junit.Test

class ServiceStopPolicyTest {
    @Test fun onlyASettledExplicitStopMayFinishTheService() {
        for (restoring in listOf(false, true))
            for (wanted in listOf(false, true))
                for (paused in listOf(false, true))
                    for (stopped in listOf(false, true)) {
                        assertEquals(!restoring && !wanted && !paused && stopped,
                            mayFinishVpnService(restoring, wanted, paused, stopped))
                    }
        assertFalse(mayFinishVpnService(false, false, true, true))
        assertFalse(mayFinishVpnService(false, true, false, true))
        assertTrue(mayFinishVpnService(false, false, false, true))
    }
}
''')
add('android/app/src/test/java/local/waarp/android/data/RoutingEditRegressionTest.kt', '''// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RoutingEditRegressionTest {
    private fun profile(id: String) = TunnelProfile(
        id = id, name = id, protocol = "Trojan", host = "example.org", port = 443,
        config = obj("type" to "trojan", "server" to "example.org", "server_port" to 443,
            "password" to "fixture-only", "tls" to obj("enabled" to true)).toString())

    @Test fun disabledDeletionAndRenamingKeepTheSameEffectiveConfigurationAfterAutoSwitch() {
        val before = AppData(profiles = listOf(profile("a"), profile("b")),
            routes = listOf(TrafficRoute("off", "Disabled", "custom", "example.net", "a", enabled = false)),
            settings = AppSettings(defaultVia = AUTO))
        val after = before.copy(routes = emptyList(), revision = 9)
        for (selected in listOf("a", "b")) {
            assertEquals(RoutingCompiler.compile(before, previousAuto = selected).json,
                RoutingCompiler.compile(after, previousAuto = selected).json)
        }
        assertNotEquals(RoutingCompiler.compile(before, previousAuto = "a").json,
            RoutingCompiler.compile(after, previousAuto = "b").json)
        assertEquals(RoutingCompiler.compile(before, previousAuto = "b").json,
            RoutingCompiler.compile(before.copy(profiles = before.profiles.map { it.copy(name = "Renamed") }),
                previousAuto = "b").json)
    }

    @Test fun activeDeletionAndChangingTheDefaultRemainEffectiveEdits() {
        val before = AppData(profiles = listOf(profile("a")),
            routes = listOf(TrafficRoute("on", "Active", "custom", "example.net", "a")),
            settings = AppSettings(defaultVia = "a"))
        assertNotEquals(RoutingCompiler.compile(before).json,
            RoutingCompiler.compile(before.copy(routes = emptyList())).json)
        assertNotEquals(RoutingCompiler.compile(before).json,
            RoutingCompiler.compile(before.copy(settings = AppSettings(defaultVia = DIRECT))).json)
    }

    @Test fun explicitChrome155RoundTripsWithoutChangingTheIosDefault() {
        val uri = "vless://00000000-0000-4000-8000-000000000001@example.org:443?security=tls"
        val original = ProfileImporter.parse(uri).profiles.single()
        val chosen = ProfileImporter.parse("$uri&fp=chrome_155").profiles.single()
        fun fp(p: TunnelProfile) = JSONObject(p.config).getJSONObject("tls").getJSONObject("utls").getString("fingerprint")
        assertEquals("ios", fp(original))
        assertEquals("chrome_155", fp(chosen))
        assertEquals("chrome_155", fp(TunnelProfile.fromJson(chosen.json())))
        assertThrows(IllegalArgumentException::class.java) { ProfileImporter.parse("$uri&fp=nonexistent") }
    }
}
''')
for path, content in pending.items():
    dest = Path(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding='utf-8')
Path('out').mkdir(exist_ok=True)
Path('out/maintenance-paths.json').write_text(json.dumps(list(pending)), encoding='utf-8')
print('Prepared', len(pending), 'reviewed source/test files:', *pending, sep='\n')
