// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.app.Application
import local.waarp.android.core.VpnController
import local.waarp.android.data.MobileRepository
import local.waarp.android.data.NetworkTools
import local.waarp.android.data.LastSessionEvidence
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class WaarpApplication : Application() {
    lateinit var repository: MobileRepository
        private set
    lateinit var network: NetworkTools
        private set
    lateinit var evidence: LastSessionEvidence
        private set
    private val evidenceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    override fun onCreate() {
        super.onCreate()
        network = NetworkTools(this)
        repository = MobileRepository(this, VpnController(this))
        evidence = LastSessionEvidence(this)
        evidenceScope.launch {
            evidence.load()
            repository.controller.status.collect { evidence.record(it, repository.controller.logs.value) }
        }
    }
}
