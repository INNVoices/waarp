// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

class RuntimeRegressionTest {
    @After fun cleanup() {
        RuntimeState.requestStop()
        RuntimeState.logs.value = emptyList()
        RuntimeState.status.value = RuntimeStatus()
    }

    @Test fun offDuringStartRejectsLateSuccess() {
        val starting = RuntimeState.requestStart("test-config")
        RuntimeState.requestStop()
        RuntimeState.updateIfCurrent(starting.generation) { it.copy(phase = RuntimePhase.ON) }
        assertEquals(RuntimePhase.OFF, RuntimeState.status.value.phase)
        assertFalse(RuntimeState.wanted())
    }

    @Test fun oldGenerationCannotReplaceNewConnectionState() {
        val old = RuntimeState.requestStart("old")
        val next = RuntimeState.requestStart("next")
        RuntimeState.status.value = RuntimeStatus(phase = RuntimePhase.STARTING)
        RuntimeState.updateIfCurrent(old.generation) { it.copy(phase = RuntimePhase.ERROR, message = "old error") }
        assertEquals(RuntimePhase.STARTING, RuntimeState.status.value.phase)
        RuntimeState.updateIfCurrent(next.generation) { it.copy(phase = RuntimePhase.ON) }
        assertEquals(RuntimePhase.ON, RuntimeState.status.value.phase)
        RuntimeState.cancelIfCurrent(old.generation)
        assertTrue(RuntimeState.isCurrent(next.generation))
    }

    @Test fun lateOffCompletionAndFailureCannotOverwriteNewStart() {
        RuntimeState.requestStart("first")
        val oldStop = RuntimeState.requestStop()
        val next = RuntimeState.requestStart("next")
        RuntimeState.updateIfCurrent(next.generation) { it.copy(phase = RuntimePhase.STARTING) }
        assertFalse(RuntimeState.finishStop(oldStop, IllegalStateException("old failure")))
        assertEquals(RuntimePhase.STARTING, RuntimeState.status.value.phase)
        var cancelledNewBackend = false
        RuntimeState.whenStopped(oldStop) { cancelledNewBackend = true }
        assertFalse(cancelledNewBackend)
    }

    @Test fun staleNativeStopAndReloadCannotReplaceNewUserIntent() {
        val old = RuntimeState.requestStart("old")
        val next = RuntimeState.requestStart("next")
        assertNull(RuntimeState.cancelIfCurrent(old.generation))
        assertNull(RuntimeState.reloadIfCurrent(old.generation))
        assertTrue(RuntimeState.isCurrent(next.generation))
        val reloaded = RuntimeState.reloadIfCurrent(next.generation)!!
        assertTrue(RuntimeState.isCurrent(reloaded.generation))
        assertNull(reloaded.config) // Reload must ask the current repository, never replay old config.
    }

    @Test fun offInvalidatesAnIdleProbeEvenWhenItHasNotEnteredTheNativeLane() {
        RuntimeState.requestStop()
        val queuedProbe = RuntimeState.idleGeneration()!!
        RuntimeState.requestStop()
        assertFalse(RuntimeState.isIdleGeneration(queuedProbe))
        val nextProbe = RuntimeState.idleGeneration()!!
        RuntimeState.requestStart("new VPN")
        assertFalse(RuntimeState.isIdleGeneration(nextProbe))
        assertNull(RuntimeState.idleGeneration())
        RuntimeState.requestStop()
        assertFalse(RuntimeState.isIdleGeneration(nextProbe))
    }

    @Test fun queuedCommandCannotCrossAnOnToOnNativeReloadWithTheSameUiState() {
        val initial = RuntimeState.requestStart("first")
        RuntimeState.status.value = RuntimeStatus(phase = RuntimePhase.ON, startedAt = 1000)
        val queued = RuntimeState.sessionGeneration()
        val reloaded = RuntimeState.reloadIfCurrent(initial.generation)!!
        // The phase and clock value deliberately remain equal; neither is an epoch.
        assertEquals(RuntimePhase.ON, RuntimeState.status.value.phase)
        assertEquals(1000L, RuntimeState.status.value.startedAt)
        assertEquals(reloaded.generation, RuntimeState.sessionGeneration())
        assertFalse(RuntimeState.isSessionGeneration(queued))
        val failure = assertThrows(IllegalStateException::class.java) { RuntimeState.commandBackend(queued) }
        assertEquals("Сессия VPN изменилась", failure.message)
        RuntimeState.requireSessionGeneration(reloaded.generation)
        RuntimeState.requestStop()
        assertFalse(RuntimeState.isSessionGeneration(reloaded.generation))
    }

    @Test fun aNativeCloseFailureStillReleasesEveryOtherResourceAndIsReported() {
        val closed = mutableListOf<String>()
        val nativeFailure = IllegalStateException("native close failed")
        val platformFailure = IllegalStateException("platform close failed")
        val result = runCatching {
            closeResources(
                { closed += "native"; throw nativeFailure },
                { closed += "platform"; throw platformFailure },
                { closed += "snapshot" },
                { closed += "executor" },
            )
        }
        assertEquals(listOf("native", "platform", "snapshot", "executor"), closed)
        assertSame(nativeFailure, result.exceptionOrNull())
        assertEquals(listOf(platformFailure), nativeFailure.suppressed.toList())
    }

    @Test fun wireGuardPublicKeyMatchesRfc7748KnownAnswer() {
        val privateKey = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
        val publicKey = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        assertEquals(Base64.getEncoder().encodeToString(publicKey),
            WireGuardKeys.publicKey(Base64.getEncoder().encodeToString(privateKey)))
    }

    @Test fun generatedKeysAreClampedAndNeverPrinted() {
        val pair = WireGuardKeys.generate()
        val privateKey = Base64.getDecoder().decode(pair.privateKey)
        assertEquals(32, privateKey.size)
        assertEquals(0, privateKey[0].toInt() and 7)
        assertEquals(0, privateKey[31].toInt() and 128)
        assertEquals(64, privateKey[31].toInt() and 64)
        assertEquals(pair.publicKey, WireGuardKeys.publicKey(pair.privateKey))
        assertFalse(pair.toString().contains(pair.privateKey))
    }

    @Test fun diagnosticRingIsBoundedAndSecretsAreRedacted() {
        val privateKey = "unit-test-private-key-do-not-print"
        RuntimeRedaction.configure("""{"private_key":"$privateKey"}""")
        repeat(600) { RuntimeState.appendLog(1, "event $it key $privateKey") }
        assertEquals(500, RuntimeState.logs.value.size)
        assertTrue(RuntimeState.logs.value.first().message.contains("event 100"))
        assertFalse(RuntimeState.logs.value.any { it.message.contains(privateKey) })
        assertFalse(RuntimeRedaction.redact("import vless://private@example.test:443").contains("private@example"))
    }

    @Test fun openVpnArrayKeysAndIndividualPemLinesAreRedacted() {
        val pemLine = "unit-test-private-base64-line-0123456789"
        val controlKey = "unit-test-control-wrap-key-0123456789"
        RuntimeRedaction.configure("""{"tls":{"client_key":["-----BEGIN PRIVATE KEY-----\n$pemLine\n-----END PRIVATE KEY-----"],"control_wrap":{"key":["$controlKey"]}}}""")
        assertFalse(RuntimeRedaction.redact("invalid key: $pemLine").contains(pemLine))
        assertFalse(RuntimeRedaction.redact("invalid key: $controlKey").contains(controlKey))
    }

    private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
