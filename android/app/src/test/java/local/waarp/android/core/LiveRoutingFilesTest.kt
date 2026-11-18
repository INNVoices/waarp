// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import kotlinx.coroutines.test.runTest
import local.waarp.android.data.*
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class LiveRoutingFilesTest {
    private fun plans(): Pair<MobileLivePlan, MobileLivePlan> {
        val p = TunnelProfile("one", "one", "Trojan", "192.0.2.1", 443,
            obj("type" to "trojan", "server" to "192.0.2.1", "server_port" to 443, "password" to "synthetic").toString())
        val data = AppData(profiles = listOf(p), routes = listOf(TrafficRoute("r", "r", "custom", "only.example.test", DIRECT)))
        val before = MobileLiveRouting.compile(data, "local.waarp.test", null, "/private/test")
        val after = MobileLiveRouting.compile(data.copy(routes = data.routes.map { it.copy(via = "one") }), "local.waarp.test", null, "/private/test", before)
        return before.live!! to after.live!!
    }

    @Test fun productionTransactionAcknowledgesGuardThenFilesThenSelectorThenGuardRemoval() = runTest {
        val (before, after) = plans()
        val events = mutableListOf<String>(); val selected = before.selections.toMutableMap()
        LiveRoutingFiles.apply(before, after, { true },
            acknowledge = { events += "ack" },
            select = { tag, target -> events += "select"; selected[tag] = target },
            selected = { selected }, onUncertain = { fail("must not stop healthy core") },
            writer = { _, tag, body -> events += if (tag == MobileLiveRouting.ROUTE_GUARD) "guard:${body.contains("only.example.test")}" else "write"; tag })
        assertEquals("guard:true", events.first())
        assertTrue(events.indexOf("select") > events.indexOf("ack"))
        assertEquals("ack", events.last())
        assertTrue(events.indexOf("guard:false") > events.indexOf("select"))
        assertEquals("p-one", selected["rt-d0"])
    }

    @Test fun failedSelectorRestoresFilesAndPreviousSelectionWithoutStoppingTheCore() = runTest {
        val (before, after) = plans()
        val disk = before.files.toMutableMap(); val selected = before.selections.toMutableMap(); var failed = false
        val result = runCatching { LiveRoutingFiles.apply(before, after, { true }, { },
            select = { tag, target -> if (!failed) { failed = true; error("selection unavailable") }; selected[tag] = target },
            selected = { selected }, onUncertain = { fail("confirmed rollback must keep VPN") },
            writer = { _, tag, body -> disk[tag] = body; tag }) }
        assertTrue(result.isFailure)
        assertEquals(before.files, disk)
        assertEquals(before.selections, selected)
    }

    @Test fun missingAcknowledgementIsNotSuccessAndUnconfirmedRollbackMarksPolicyUncertain() = runTest {
        val (before, after) = plans(); var closed = false; var selected = false
        val result = runCatching { LiveRoutingFiles.apply(before, after, { true }, { error("watcher did not reload") },
            select = { _, _ -> selected = true }, selected = { before.selections }, onUncertain = { closed = true }, writer = { _, tag, _ -> tag }) }
        assertTrue(result.isFailure); assertTrue(closed); assertFalse(selected)
    }

    @Test fun explicitOffStopsOldWritesAndNeverMutatesAReplacementSession() = runTest {
        val (before, after) = plans(); var current = true; var writes = 0; var selected = false; var closed = false
        val result = runCatching { LiveRoutingFiles.apply(before, after, { current }, { current = false },
            select = { _, _ -> selected = true }, selected = { before.selections }, onUncertain = { closed = true },
            writer = { _, tag, _ -> writes++; tag }) }
        assertTrue(result.isFailure); assertEquals(2, writes); assertFalse(selected); assertFalse(closed)
    }

    @Test fun unchangedPlanDoesNoNativeWork() = runTest {
        val (before, _) = plans()
        LiveRoutingFiles.apply(before, before, { true }, { fail("no ack") }, { _, _ -> fail("no select") },
            { before.selections }, { fail("no stop") }, writer = { _, _, _ -> error("no writes") })
    }

    @Test fun initialFilesArePrivateAtomicDocumentsWithDistinctWitnesses() {
        val directory = Files.createTempDirectory("waarp-rules-").toFile()
        try {
            val plan = plans().first.copy(directory = directory.absolutePath)
            LiveRoutingFiles.initialize(plan)
            assertEquals(plan.files.size, directory.listFiles()!!.size)
            val witnesses = directory.listFiles()!!.map { file ->
                org.json.JSONObject(file.readText()).getJSONArray("rules").getJSONObject(0).stringList("domain").single()
            }
            assertEquals(witnesses.size, witnesses.distinct().size)
            assertTrue(witnesses.all { it.endsWith(".${MobileLiveRouting.CANARY_ZONE}") })
        } finally { directory.deleteRecursively() }
    }
}
