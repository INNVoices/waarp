package local.waarp.android.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import local.waarp.android.core.RuntimeProbeResult
import org.junit.Assert.*
import org.junit.Test

class HealthProbeTest {
    private fun result(tag: String, delay: Long?) = RuntimeProbeResult(tag, delay, if (delay == null) "unreachable" else null, 100)

    @Test fun onlyFailedPathsUseTheIndependentTargetAndZeroLatencyIsPreserved() = runBlocking {
        val requests = mutableListOf<Pair<List<String>, String>>()
        val values = HealthProbe.run(listOf("fast", "retry"), HealthProbe.PRIMARY, true, { true }) { tags, url ->
            requests += tags to url
            if (url == HealthProbe.PRIMARY) listOf(result("fast", 0), result("retry", null))
            else listOf(result("retry", 25))
        }
        assertEquals(listOf(listOf("fast", "retry") to HealthProbe.PRIMARY, listOf("retry") to HealthProbe.SECONDARY), requests)
        assertEquals(listOf(0L, 25L), values.map { it.delayMs })
        assertTrue(ProbeHealth(failures = 1).measured(values[1].delayMs, values[1].checkedAt).healthy)
    }

    @Test fun bothIndependentSitesMustFailBeforeTheRoundCountsAsAFailure() = runBlocking {
        var requests = 0
        val values = HealthProbe.run(listOf("tunnel"), HealthProbe.PRIMARY, true, { true }) { tags, _ ->
            requests++; tags.map { result(it, null) }
        }
        assertEquals(2, requests)
        assertNull(values.single().delayMs)
        val oneRound = ProbeHealth().measured(values.single().delayMs, 100)
        assertFalse(oneRound.down)
        assertTrue(oneRound.measured(values.single().delayMs, 200).down)
    }

    @Test fun explicitDiagnosticsNeverReplaceTheRequestedSiteEvenWhenItIsTheHealthUrl() = runBlocking {
        for (url in listOf("https://example.test/diagnostic", HealthProbe.PRIMARY)) {
            val requests = mutableListOf<String>()
            val values = HealthProbe.run(listOf("tunnel"), url, false, { true }) { tags, target ->
                requests += target; tags.map { result(it, null) }
            }
            assertEquals(listOf(url), requests)
            assertNull(values.single().delayMs)
        }
    }

    @Test fun stoppedOrChangedSessionCannotStartTheSecondaryProbeOrPublishOldResults() = runBlocking {
        var current = true
        var requests = 0
        val values = HealthProbe.run(listOf("tunnel"), HealthProbe.PRIMARY, true, { current }) { tags, _ ->
            requests++; current = false; tags.map { result(it, null) }
        }
        assertEquals(1, requests)
        assertTrue(values.isEmpty())
    }

    @Test fun coroutineCancellationNeverBecomesAFailedMeasurementOrRetry() {
        var requests = 0
        assertThrows(CancellationException::class.java) {
            runBlocking {
                HealthProbe.run(listOf("tunnel"), HealthProbe.PRIMARY, true, { true }) { _, _ ->
                    requests++; throw CancellationException("Stopped")
                }
            }
        }
        assertEquals(1, requests)
    }
}
