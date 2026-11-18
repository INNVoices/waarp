// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class StructuralRestartApprovalTest {
    @Test fun noApprovalNeededForCompatibleLiveOrInertChanges() = runBlocking {
        var prompts = 0
        assertTrue(StructuralRestartApproval.allowed(false, { true }) { prompts++; false })
        assertEquals(0, prompts)
    }
    @Test fun missingUiAndDenialPreserveOriginalSession() = runBlocking {
        assertFalse(StructuralRestartApproval.allowed(true, { true }, null))
        assertFalse(StructuralRestartApproval.allowed(true, { true }) { false })
    }
    @Test fun staleIntentCannotAskOrApplyOldApproval() = runBlocking {
        var asks = 0
        assertFalse(StructuralRestartApproval.allowed(true, { false }) { asks++; true })
        assertEquals(0, asks)
        var current = true
        assertFalse(StructuralRestartApproval.allowed(true, { current }) { current = false; true })
        assertTrue(StructuralRestartApproval.allowed(true, { true }) { true })
    }
}
