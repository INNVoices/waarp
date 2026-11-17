// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core;

import android.app.Activity;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.os.SystemClock;
import android.system.ErrnoException;
import org.json.JSONObject;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A separate test-APK UID exercises Android owner attribution and the real TUN.
 * It intentionally uses only Android/JDK APIs: instrumented dependencies such as
 * Kotlin are deduplicated into the target APK, which this separate process cannot load.
 */
public final class ProbeActivity extends Activity {
    private String dnsFailure = "";
    private ConnectivityManager connectivity;
    private ConnectivityManager.NetworkCallback networkCallback;
    private boolean callbackRegistered;
    private ProbeNetworkState networkState;
    private ProbeNetworkState.Snapshot readyNetwork;
    private int interfaceIndexAtReady = -1, socketLocalInterfaceIndex = -1;
    private long udpSendElapsedMs = -1, udpSendUnixMs = -1, udpSentElapsedMs = -1;
    private String localAddressMatchesReadyVpnLinkAddress = "unknown";
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
        new Thread(() -> runProbe(url, dns, destination), "waarp-test-http").start();
    }

    private void runProbe(String url, boolean dns, String destination) {
        try {
            // Service/TUN readiness precedes delivery of the new default network
            // to a different UID. Exercise the actual VPN once Android exposes it.
            try {
                awaitVpnNetwork();
            } catch (Exception error) {
                finishProbe(dns, destination, -1, failureCategory("vpn-network", error));
                return;
            }
            if (dns) {
                int code = dnsThroughTun() ? 204 : -1;
                finishProbe(true, destination, code, dnsFailure);
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
            finishProbe(false, destination, code, failure);
        } finally {
            if (callbackRegistered) connectivity.unregisterNetworkCallback(networkCallback);
        }
    }

    private void finishProbe(boolean dns, String destination, int code, String failure) {
        sendBroadcast(new Intent(dns ? "local.waarp.android.TEST_DNS_RESULT" : "local.waarp.android.TEST_HTTP_RESULT")
                .setPackage(destination).putExtra("code", code).putExtra("error", failure)
                .putExtra("networkDiagnostics", networkDiagnostics()));
        runOnUiThread(this::finish);
    }

    private String networkDiagnostics() {
        Map<String, Object> values = new LinkedHashMap<>();
        values.put("interfaceIndexAtReady", interfaceIndexAtReady);
        values.put("socketLocalInterfaceIndex", socketLocalInterfaceIndex);
        values.put("udpSendElapsedMs", udpSendElapsedMs);
        values.put("udpSendUnixMs", udpSendUnixMs);
        values.put("udpSentElapsedMs", udpSentElapsedMs);
        values.put("localAddressMatchesReadyVpnLinkAddress", localAddressMatchesReadyVpnLinkAddress);
        values.put("readySnapshot", readyNetwork == null ? JSONObject.NULL : readyNetwork.safeScalars());
        values.put("latestSnapshot", networkState == null ? JSONObject.NULL : networkState.snapshot().safeScalars());
        return new JSONObject(values).toString();
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
            InetAddress local = socket.getLocalAddress();
            localAddressMatchesReadyVpnLinkAddress = readyNetwork.localAddressMatches(local);
            try {
                NetworkInterface localInterface = NetworkInterface.getByInetAddress(local);
                socketLocalInterfaceIndex = localInterface == null ? -1 : localInterface.getIndex();
            } catch (IOException unavailable) { socketLocalInterfaceIndex = -1; }
            stage = "udp-send";
            udpSendElapsedMs = SystemClock.elapsedRealtime();
            udpSendUnixMs = System.currentTimeMillis();
            socket.send(new DatagramPacket(query, query.length));
            udpSentElapsedMs = SystemClock.elapsedRealtime();
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
        connectivity = getSystemService(ConnectivityManager.class);
        networkState = new ProbeNetworkState(SystemClock::elapsedRealtime);
        // Android sends an ordered initial snapshot (including blocked=false on API29).
        // Synchronous ConnectivityManager reads inside callbacks can race that stream.
        // https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) {
                networkState.onAvailable(network.getNetworkHandle());
            }
            @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                networkState.onCapabilitiesChanged(network.getNetworkHandle(),
                        capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN));
            }
            @Override public void onLinkPropertiesChanged(Network network, LinkProperties properties) {
                InetAddress[] addresses = properties.getLinkAddresses().stream()
                        .map(address -> address.getAddress()).toArray(InetAddress[]::new);
                networkState.onLinkPropertiesChanged(network.getNetworkHandle(), properties.getInterfaceName(), addresses);
            }
            @Override public void onBlockedStatusChanged(Network network, boolean blocked) {
                networkState.onBlockedStatusChanged(network.getNetworkHandle(), blocked);
            }
            @Override public void onLost(Network network) {
                networkState.onLost(network.getNetworkHandle());
            }
        };
        connectivity.registerDefaultNetworkCallback(networkCallback);
        callbackRegistered = true;
        readyNetwork = networkState.awaitReady();
        try {
            NetworkInterface readyInterface = NetworkInterface.getByName(readyNetwork.interfaceName);
            interfaceIndexAtReady = readyInterface == null ? -1 : readyInterface.getIndex();
        } catch (IOException unavailable) { interfaceIndexAtReady = -1; }
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
