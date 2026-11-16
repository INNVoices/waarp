// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * A separate test-APK UID exercises Android owner attribution and the real TUN.
 * It intentionally uses only Android/JDK APIs: instrumented dependencies such as
 * Kotlin are deduplicated into the target APK, which this separate process cannot load.
 */
public final class ProbeActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        String destination = getIntent().getStringExtra("destination");
        if (url == null || destination == null) {
            finish();
            return;
        }
        new Thread(() -> {
            int code = -1;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(8_000);
                connection.setReadTimeout(8_000);
                connection.setInstanceFollowRedirects(false);
                code = connection.getResponseCode();
            } catch (Exception ignored) {
                // The test checks the status code; a transport failure is never a success.
            } finally {
                if (connection != null) connection.disconnect();
            }
            sendBroadcast(new Intent("local.waarp.android.TEST_HTTP_RESULT")
                    .setPackage(destination).putExtra("code", code));
            runOnUiThread(this::finish);
        }, "waarp-test-http").start();
    }
}
