// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import local.waarp.android.data.MobileLiveRouting
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException

/** Local synthetic DNS traverses the existing TUN and proves that its rule files reloaded. */
internal object RoutingWitness {
    fun query(id: Int, name: String): ByteArray {
        require(name.endsWith(".${MobileLiveRouting.CANARY_ZONE}"))
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.writeShort(id); out.writeShort(0x100); out.writeShort(1)
            repeat(3) { out.writeShort(0) }
            name.split('.').forEach { label -> require(label.length in 1..63); out.writeByte(label.length); out.write(label.toByteArray(Charsets.US_ASCII)) }
            out.writeByte(0); out.writeShort(1); out.writeShort(1)
        }
        return bytes.toByteArray()
    }

    fun acknowledged(packet: ByteArray, length: Int, expectedId: Int, name: String): Boolean = runCatching {
        fun u16(at: Int): Int { require(at + 2 <= length); return ((packet[at].toInt() and 255) shl 8) or (packet[at + 1].toInt() and 255) }
        // Only a complete standard response is an ACK; a valid-looking A record in
        // a truncated or non-query opcode response cannot prove the reload.
        require(length >= 12 && u16(0) == expectedId && u16(2) and 0xfa0f == 0x8000 && u16(4) == 1)
        val query = query(expectedId, name)
        require(length >= query.size && packet.copyOfRange(12, query.size).contentEquals(query.copyOfRange(12, query.size)))
        var cursor = query.size
        repeat(u16(6).coerceAtMost(32)) {
            var labels = 0
            while (true) {
                require(cursor < length && labels++ < 128)
                val size = packet[cursor++].toInt() and 255
                if (size == 0) break
                if (size and 0xc0 == 0xc0) { require(cursor < length); cursor++; break }
                require(size <= 63 && cursor + size <= length); cursor += size
            }
            val type = u16(cursor); val klass = u16(cursor + 2); val size = u16(cursor + 8); cursor += 10
            require(cursor + size <= length)
            if (type == 1 && klass == 1 && size == 4 && packet.copyOfRange(cursor, cursor + 4).contentEquals(byteArrayOf(127, 0, 0, 9))) return true
            cursor += size
        }
        false
    }.getOrDefault(false)

    fun await(names: List<String>, current: () -> Boolean) {
        if (names.isEmpty()) return
        require(names.size < 60_000)
        val pending = names.distinct().mapIndexed { index, name -> index + 1 to name }.toMap().toMutableMap()
        val target = InetAddress.getByName("172.19.0.2")
        val deadline = System.nanoTime() + 4_500_000_000L
        DatagramSocket().use { socket ->
            // Intentionally NOT protected/bound to the physical network: this probe must
            // reach the existing VPN, and its .invalid reply is defined entirely locally.
            socket.connect(target, 53); socket.soTimeout = 150
            var sendAt = 0L
            while (pending.isNotEmpty()) {
                check(current()) { "Проверка маршрута отменена" }
                val now = System.nanoTime()
                check(now < deadline) { "Ядро не подтвердило обновление правил" }
                if (now >= sendAt) {
                    pending.forEach { (id, name) -> val bytes = query(id, name); socket.send(DatagramPacket(bytes, bytes.size)) }
                    sendAt = now + 200_000_000L
                }
                val response = DatagramPacket(ByteArray(2048), 2048)
                try {
                    socket.receive(response)
                    if (response.length < 2) continue
                    val id = ((response.data[0].toInt() and 255) shl 8) or (response.data[1].toInt() and 255)
                    val name = pending[id] ?: continue
                    if (acknowledged(response.data, response.length, id, name)) pending.remove(id)
                } catch (_: SocketTimeoutException) { /* Retry only while this generation owns the TUN. */ }
            }
        }
    }
}
