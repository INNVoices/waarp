// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core;

import android.app.Activity;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.system.ErrnoException;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.URL;
import java.security.SecureRandom;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * A separate test-APK UID exercises Android owner attribution and the real TUN.
 * It intentionally uses only Android/JDK APIs: instrumented dependencies such as
 * Kotlin are deduplicated into the target APK, which this separate process cannot load.
 */
public final class ProbeActivity extends Activity {
    private String dnsFailure = "";
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra("url");
        boolean dns = getIntent().getBooleanExtra("dns", false);
        String destination = getIntent().getStringExtra("destination");
        if ((!dns && url == null) || destination == null) {
            finish();
            return;
        }
        new Thread(() -> {
            // Service/TUN readiness precedes delivery of the new default network
            // to a different UID. Exercise the actual VPN once Android exposes it.
            try {
                awaitVpnNetwork();
            } catch (Exception error) {
                sendBroadcast(new Intent(dns ? "local.waarp.android.TEST_DNS_RESULT" : "local.waarp.android.TEST_HTTP_RESULT")
                        .setPackage(destination).putExtra("code", -1).putExtra("error", failureCategory("vpn-network", error)));
                runOnUiThread(this::finish);
                return;
            }
            if (dns) {
                int code = dnsThroughTun() ? 204 : -1;
                sendBroadcast(new Intent("local.waarp.android.TEST_DNS_RESULT")
                        .setPackage(destination).putExtra("code", code).putExtra("error", dnsFailure));
                runOnUiThread(this::finish);
                return;
            }
            int code = -1;
            String failure = "";
            String stage = "http-open";
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setConnectTimeout(8_000);
                connection.setReadTimeout(8_000);
                connection.setInstanceFollowRedirects(false);
                stage = "http-connect";
                connection.connect();
                stage = "http-response";
                code = connection.getResponseCode();
            } catch (Exception error) {
                // The test checks the status code; a transport failure is never a success.
                failure = failureCategory(stage, error);
            } finally {
                if (connection != null) connection.disconnect();
            }
            sendBroadcast(new Intent("local.waarp.android.TEST_HTTP_RESULT")
                    .setPackage(destination).putExtra("code", code).putExtra("error", failure));
            runOnUiThread(this::finish);
        }, "waarp-test-http").start();
    }

    private boolean dnsThroughTun() {
        // A new transaction ID, no Java/Android DNS cache, and a separate application UID.
        byte[] query = new byte[] {0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
                7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 3, 'c', 'o', 'm', 0, 0, 1, 0, 1};
        int id = new SecureRandom().nextInt(65536);
        query[0] = (byte) (id >>> 8);
        query[1] = (byte) id;
        String stage = "udp-open";
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setSoTimeout(10_000);
            stage = "udp-connect";
            socket.connect(InetAddress.getByAddress(new byte[] {10, 77, 0, 1}), 53);
            stage = "udp-send";
            socket.send(new DatagramPacket(query, query.length));
            byte[] answer = new byte[4096];
            DatagramPacket packet = new DatagramPacket(answer, answer.length);
            stage = "udp-receive";
            socket.receive(packet);
            int size = packet.getLength();
            boolean matched = hasSyntheticAnswer(answer, size, query);
            if (!matched) dnsFailure = "UnexpectedDnsAnswer";
            return matched;
        } catch (Exception error) {
            dnsFailure = failureCategory(stage, error);
            return false;
        }
    }

    private void awaitVpnNetwork() throws IOException, InterruptedException {
        ConnectivityManager manager = getSystemService(ConnectivityManager.class);
        CountDownLatch ready = new CountDownLatch(1);
        ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                if (network.equals(manager.getActiveNetwork()) && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    ready.countDown();
                }
            }
        };
        manager.registerDefaultNetworkCallback(callback);
        try {
            Network network = manager.getActiveNetwork();
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return;
            if (!ready.await(10, TimeUnit.SECONDS)) throw new IOException("VPN network did not become active for the probe UID");
        } finally {
            manager.unregisterNetworkCallback(callback);
        }
    }

    private static String failureCategory(String stage, Throwable error) {
        StringBuilder result = new StringBuilder(stage);
        for (int depth = 0; error != null && depth < 5; depth++, error = error.getCause()) {
            result.append('/').append(error.getClass().getSimpleName());
            if (error instanceof ErrnoException) result.append(":errno=").append(((ErrnoException) error).errno);
        }
        return result.toString();
    }

    private static boolean hasSyntheticAnswer(byte[] answer, int size, byte[] query) {
        if (size < 28 || answer[0] != query[0] || answer[1] != query[1]
                || (answer[2] & 0x80) == 0 || (answer[3] & 0x0f) != 0) return false;
        int questions = unsigned16(answer, 4), answers = unsigned16(answer, 6), offset = 12;
        if (questions != 1 || answers < 1 || answers > 16) return false;
        offset = skipName(answer, size, offset);
        if (offset < 0 || offset + 4 > size) return false;
        offset += 4;
        for (int index = 0; index < answers; index++) {
            offset = skipName(answer, size, offset);
            if (offset < 0 || offset + 10 > size) return false;
            int type = unsigned16(answer, offset), family = unsigned16(answer, offset + 2);
            int length = unsigned16(answer, offset + 8);
            offset += 10;
            if (offset + length > size) return false;
            // A direct/public DNS answer cannot be the fixture's documentation-only address.
            if (type == 1 && family == 1 && length == 4 && (answer[offset] & 0xff) == 192
                    && answer[offset + 1] == 0 && answer[offset + 2] == 2 && answer[offset + 3] == 42) return true;
            offset += length;
        }
        return false;
    }

    private static int skipName(byte[] packet, int size, int offset) {
        for (int labels = 0; labels < 128 && offset < size; labels++) {
            int length = packet[offset++] & 0xff;
            if (length == 0) return offset;
            if ((length & 0xc0) == 0xc0) return offset < size ? offset + 1 : -1;
            if (length > 63 || offset + length > size) return -1;
            offset += length;
        }
        return -1;
    }

    private static int unsigned16(byte[] bytes, int offset) {
        return ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff);
    }
}
