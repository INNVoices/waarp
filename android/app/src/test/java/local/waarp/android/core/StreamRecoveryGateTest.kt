// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamRecoveryGateTest {
    @Test fun aSubscriptionFailureDuringConnectCannotBeOverwrittenByConnectReturning() {
        val gate = StreamRecoveryGate()
        assertTrue(gate.begin())
        // Connect launches native stream goroutines before it returns. Their
        // failure must survive even while the reconnect worker already exists.
        assertFalse(gate.failed(11))
        assertTrue(gate.hasFailed(11))
        assertFalse(gate.connected(11))
        assertTrue(gate.recovering)
        assertTrue(gate.connected(12))
        assertFalse(gate.recovering)
        assertFalse(gate.hasFailed(12))
    }

    @Test fun failureAfterAHealthyConnectionSchedulesOneWorkerForAllLostStreams() {
        val gate = StreamRecoveryGate()
        gate.begin()
        assertTrue(gate.connected(20))
        assertTrue(gate.failed(20))
        repeat(5) { assertFalse(gate.failed(20)) }
        assertFalse(gate.connected(20))
        assertTrue(gate.connected(21))
        assertTrue(gate.failed(21))
    }
}
