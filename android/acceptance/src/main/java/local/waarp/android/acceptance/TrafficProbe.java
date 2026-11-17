package local.waarp.android.acceptance;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import local.waarp.android.core.crypto.Curve25519;

/** Real independent-UID traffic. Neither production classes nor JNI are used. */
final class TrafficProbe {
    static final String INNER_IP = "10.77.0.1";
    static final int HTTP_PORT = 18080;
    static final int PAYLOAD_BYTES = 64 * 1024;
    private final Context context;
    private final SecureRandom random = new SecureRandom();
    private final String runId = Long.toUnsignedString(random.nextLong(), 36);
    private long sequence;

    TrafficProbe(Context context) { this.context = context; }

    String createProfile() throws Exception {
        require(!vpnActive(), "fixture_registration_requires_vpn_off");
        byte[] privateKey = new byte[32];
        byte[] publicKey = new byte[32];
        random.nextBytes(privateKey);
        privateKey[0] &= (byte) 248;
        privateKey[31] &= (byte) 127;
        privateKey[31] |= (byte) 64;
        Curve25519.eval(publicKey, 0, privateKey, null);
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL("http://10.0.2.2:18081/register").openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            byte[] registration = new JSONObject().put("public_key", Base64.encodeToString(publicKey, Base64.NO_WRAP)).toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(registration.length);
            JSONObject peer;
            try {
                try (java.io.OutputStream output = connection.getOutputStream()) { output.write(registration); }
                require(connection.getResponseCode() == 200, "fixture_registration_status");
                try (InputStream input = connection.getInputStream()) {
                    peer = new JSONObject(new String(readBounded(input, 2048), StandardCharsets.UTF_8));
                }
            } finally { connection.disconnect(); }
            String serverKey = peer.getString("server_public_key");
            require(Base64.decode(serverKey, Base64.DEFAULT).length == 32 && peer.getInt("endpoint_port") == 18081, "fixture_public_contract");
            return "[Interface]\nPrivateKey=" + Base64.encodeToString(privateKey, Base64.NO_WRAP) +
                    "\nAddress=10.77.0.2/32\nDNS=10.77.0.1\nMTU=1280\n" +
                    "Jc=2\nJmin=32\nJmax=64\nS1=80\nS2=20\nS3=35\nS4=12\n" +
                    "H1=1000-1100\nH2=2000-2100\nH3=3000-3100\nH4=4000-4100\nI1=<r 24>\n" +
                    "[Peer]\nPublicKey=" + serverKey + "\nEndpoint=10.0.2.2:18081\nAllowedIPs=10.77.0.1/32\nPersistentKeepalive=15\n";
        } finally { Arrays.fill(privateKey, (byte) 0); Arrays.fill(publicKey, (byte) 0); }
    }

    boolean vpnActive() {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        Network network = manager.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
    }

    Set<String> physicalNetworks() {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        Set<String> result = new HashSet<>();
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            if (capabilities != null && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) &&
                    capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) result.add(network.toString());
        }
        return result;
    }

    JSONObject exchange(int timeoutMs) throws Exception {
        require(vpnActive(), "probe_uid_not_on_vpn");
        long started = SystemClock.elapsedRealtime();
        long index = ++sequence;
        String nonce = runId + "-" + Long.toUnsignedString(index, 36);
        String domain = nonce + ".soak.waarp.test";
        long dnsStarted = SystemClock.elapsedRealtime();
        int dnsBytes = query(domain, timeoutMs);
        long dnsMs = SystemClock.elapsedRealtime() - dnsStarted;
        long httpStarted = SystemClock.elapsedRealtime();
        int httpBytes = http(nonce, domain, timeoutMs);
        return new JSONObject().put("sequence", index).put("elapsedRealtimeMs", started)
                .put("unixMs", System.currentTimeMillis()).put("dnsMs", dnsMs)
                .put("httpMs", SystemClock.elapsedRealtime() - httpStarted).put("totalMs", SystemClock.elapsedRealtime() - started)
                .put("dnsBytes", dnsBytes).put("httpBytes", httpBytes).put("vpn", true).put("passed", true);
    }

    /** Negative gate still sends a new DNS request; it does not trust a UI label. */
    void requireInnerTrafficBlocked(int timeoutMs) throws Exception {
        boolean answered = false;
        try { query(runId + "-blocked-" + (++sequence) + ".soak.waarp.test", timeoutMs); answered = true; }
        catch (DnsRejectedException expected) { /* an explicit negative DNS reply */ }
        catch (java.net.SocketTimeoutException | java.net.NoRouteToHostException | java.net.PortUnreachableException expected) { /* an expected network block */ }
        catch (java.net.SocketException expected) { /* ENETUNREACH/ECONNREFUSED also proves no reply */ }
        require(!answered, "inner_dns_replied_when_blocked");
    }

    private int query(String domain, int timeoutMs) throws Exception {
        int id = random.nextInt(65536);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeShort(id); output.writeShort(0x0100); output.writeShort(1);
            output.writeShort(0); output.writeShort(0); output.writeShort(0);
            for (String label : domain.split("\\.")) {
                byte[] encoded = label.getBytes(StandardCharsets.US_ASCII);
                require(encoded.length > 0 && encoded.length <= 63, "dns_label_length");
                output.writeByte(encoded.length); output.write(encoded);
            }
            output.writeByte(0); output.writeShort(1); output.writeShort(1);
        }
        byte[] response = new byte[4096];
        DatagramPacket received = new DatagramPacket(response, response.length);
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setSoTimeout(timeoutMs);
            socket.connect(InetAddress.getByName(INNER_IP), 53);
            socket.send(new DatagramPacket(bytes.toByteArray(), bytes.size()));
            socket.receive(received);
        }
        byte[] packet = Arrays.copyOf(response, received.getLength());
        require(packet.length >= 12 && u16(packet, 0) == id && (u16(packet, 2) & 0x8000) != 0 && u16(packet, 4) == 1, "dns_response_header");
        int[] cursor = {12};
        require(readName(packet, cursor).equals(domain + "."), "dns_response_question");
        require(u16(packet, cursor[0]) == 1 && u16(packet, cursor[0] + 2) == 1, "dns_response_question_type");
        cursor[0] += 4;
        if ((u16(packet, 2) & 15) != 0) throw new DnsRejectedException();
        boolean found = false;
        for (int index = 0; index < u16(packet, 6); index++) {
            String answerName = readName(packet, cursor);
            int offset = cursor[0];
            require(offset + 10 <= packet.length, "dns_answer_bounds");
            int type = u16(packet, offset), clazz = u16(packet, offset + 2), length = u16(packet, offset + 8);
            cursor[0] = offset + 10 + length;
            require(cursor[0] <= packet.length, "dns_answer_data_bounds");
            if (type == 1 && clazz == 1 && length == 4 && answerName.equals(domain + ".")) {
                require(packet[offset + 4] == 0 && packet[offset + 5] == 0 && packet[offset + 6] == 0 && packet[offset + 7] == 0, "dns_fixture_ttl");
                require(Arrays.equals(Arrays.copyOfRange(packet, offset + 10, offset + 14), new byte[]{10, 77, 0, 1}), "dns_fixture_address");
                found = true;
            }
        }
        require(found, "dns_fixture_answer_missing");
        return packet.length;
    }

    private int http(String nonce, String domain, int timeoutMs) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("http://" + INNER_IP + ":" + HTTP_PORT + "/probe?nonce=" + nonce).openConnection();
        connection.setConnectTimeout(timeoutMs); connection.setReadTimeout(timeoutMs);
        connection.setUseCaches(false); connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Host", domain); connection.setRequestProperty("Connection", "close");
        try {
            require(connection.getResponseCode() == 200, "inner_http_status");
            byte[] body;
            try (InputStream input = connection.getInputStream()) { body = readBounded(input, PAYLOAD_BYTES + 256); }
            byte[] prefix = ("waarp-acceptance:" + nonce + "\n").getBytes(StandardCharsets.US_ASCII);
            require(body.length == prefix.length + PAYLOAD_BYTES, "inner_http_payload_length");
            for (int i = 0; i < prefix.length; i++) require(body[i] == prefix[i], "inner_http_nonce");
            for (int i = prefix.length; i < body.length; i++) require(body[i] == 'w', "inner_http_payload");
            return body.length;
        } finally { connection.disconnect(); }
    }

    private static int u16(byte[] data, int index) {
        require(index >= 0 && index + 2 <= data.length, "dns_uint16_bounds");
        return ((data[index] & 255) << 8) | (data[index + 1] & 255);
    }

    private static String readName(byte[] packet, int[] cursor) {
        int position = cursor[0], jumps = 0; boolean jumped = false;
        StringBuilder name = new StringBuilder();
        while (true) {
            require(position < packet.length && jumps++ < 128, "dns_name_bounds");
            int length = packet[position++] & 255;
            if ((length & 0xc0) == 0xc0) {
                require(position < packet.length, "dns_pointer_bounds");
                if (!jumped) cursor[0] = position + 1;
                position = ((length & 0x3f) << 8) | (packet[position] & 255); jumped = true; continue;
            }
            require(length <= 63 && position + length <= packet.length, "dns_label_bounds");
            if (length == 0) { if (!jumped) cursor[0] = position; return name.toString(); }
            name.append(new String(packet, position, length, StandardCharsets.US_ASCII)).append('.'); position += length;
            require(name.length() <= 254, "dns_name_length");
        }
    }

    private static byte[] readBounded(InputStream input, int limit) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int count; (count = input.read(buffer)) != -1;) {
            require(output.size() + count <= limit, "response_size_limit"); output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    static void require(boolean condition, String category) { if (!condition) throw new AssertionError(category); }
    private static final class DnsRejectedException extends java.io.IOException {
        DnsRejectedException() { super("dns_explicit_negative_response"); }
    }
}
