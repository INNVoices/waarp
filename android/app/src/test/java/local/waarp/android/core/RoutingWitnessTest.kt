package local.waarp.android.core

import local.waarp.android.data.MobileLiveRouting
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream

class RoutingWitnessTest {
    private val name = "abcd.${MobileLiveRouting.CANARY_ZONE}"
    private fun answer(id: Int = 42, queryName: String = name, ip: ByteArray = byteArrayOf(127, 0, 0, 9)): ByteArray {
        val request = RoutingWitness.query(id, queryName)
        val body = ByteArrayOutputStream()
        DataOutputStream(body).use { out ->
            out.writeShort(id); out.writeShort(0x8180); out.writeShort(1); out.writeShort(1); out.writeShort(0); out.writeShort(0)
            out.write(request, 12, request.size - 12)
            out.writeShort(0xc00c); out.writeShort(1); out.writeShort(1); out.writeInt(0); out.writeShort(4); out.write(ip)
        }
        return body.toByteArray()
    }
    @Test fun onlyExactQuestionIdAndLocalAnswerAcknowledgeTheFile() {
        val valid = answer()
        assertTrue(RoutingWitness.acknowledged(valid, valid.size, 42, name))
        for (invalid in listOf(answer(id = 43), answer(queryName = "other.${MobileLiveRouting.CANARY_ZONE}"), answer(ip = byteArrayOf(1, 1, 1, 1)),
            valid.copyOf().also { it[3] = 0x83.toByte() }, valid.copyOf().also { it[2] = 1 },
            valid.copyOf().also { it[2] = 0x83.toByte() }, valid.copyOf().also { it[2] = 0x89.toByte() }))
            assertFalse(RoutingWitness.acknowledged(invalid, invalid.size, 42, name))
        for (length in valid.indices) assertFalse(RoutingWitness.acknowledged(valid, length, 42, name))
    }
    @Test fun malformedDnsIsRejectedWithoutThrowingOrCallingExternalResolvers() {
        for (size in 0..128) assertFalse(RoutingWitness.acknowledged(ByteArray(size) { 0xff.toByte() }, size, 42, name))
        assertThrows(IllegalArgumentException::class.java) { RoutingWitness.query(42, "example.com") }
    }
}
