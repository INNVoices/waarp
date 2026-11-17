// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android

import android.app.Application
import local.waarp.android.core.VpnController
import local.waarp.android.data.MobileRepository
import local.waarp.android.data.NetworkTools

class WaarpApplication : Application() {
    lateinit var repository: MobileRepository
        private set
    lateinit var network: NetworkTools
        private set
    override fun onCreate() {
        super.onCreate()
        network = NetworkTools(this)
        repository = MobileRepository(this, VpnController(this))
    }
}
