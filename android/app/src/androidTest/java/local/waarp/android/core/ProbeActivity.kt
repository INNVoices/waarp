// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import java.net.HttpURLConnection
import java.net.URL

/** Only in the instrumentation APK; its UID is distinct from the VPN app's own bypassed UID. */
class ProbeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra("url") ?: return finish()
        val destination = intent.getStringExtra("destination") ?: return finish()
        Thread({
            val code = runCatching {
                (URL(url).openConnection() as HttpURLConnection).let { connection ->
                    try {
                        connection.connectTimeout = 8_000
                        connection.readTimeout = 8_000
                        connection.instanceFollowRedirects = false
                        connection.responseCode
                    } finally { connection.disconnect() }
                }
            }.getOrDefault(-1)
            sendBroadcast(Intent("local.waarp.android.TEST_HTTP_RESULT").setPackage(destination).putExtra("code", code))
            runOnUiThread { finish() }
        }, "waarp-test-http").start()
    }
}
