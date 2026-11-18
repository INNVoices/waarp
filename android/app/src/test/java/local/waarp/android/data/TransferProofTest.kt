package local.waarp.android.data

import local.waarp.android.core.RuntimeHttpResult
import org.junit.Assert.*
import org.junit.Test

class TransferProofTest {
    private fun response(content: String = "", status: Int = 200, truncated: Boolean = false) =
        RuntimeHttpResult(status, content, truncated, "text/plain", 25)

    @Test fun exactPayloadPassesOnlyWithSuccessfulCompleteResponse() {
        val content = "abc"
        // Published SHA-256 test vector; using a literal avoids sharing the digest implementation.
        val sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        val result = TransferProof.validateDownload(response(content), 3, sha256)
        assertEquals("pass", result.state)
        assertEquals(3, result.bytes)
        assertEquals(25L, result.elapsedMs)
        assertEquals("content", TransferProof.validateDownload(response("abd"), 3, sha256).reason)
        assertEquals("size", TransferProof.validateDownload(response("ab"), 3, sha256).reason)
        assertEquals("truncated", TransferProof.validateDownload(response(content, truncated = true), 3, sha256).reason)
        assertEquals("http", TransferProof.validateDownload(response(content, status = 503), 3, sha256).reason)
        assertEquals("fail", TransferProof.download(response(content)).state)
    }

    @Test fun headersShortRepliesAndSameSizeWrongContentNeverProvePayload() {
        assertEquals("http", TransferProof.download(response(status = 204)).reason)
        assertEquals("size", TransferProof.download(response("OK")).reason)
        assertEquals("truncated", TransferProof.download(response("x".repeat(TransferProof.BYTES), truncated = true)).reason)
        val sameSize = TransferProof.download(response("x".repeat(TransferProof.BYTES)))
        assertEquals("fail", sameSize.state)
        assertEquals("content", sameSize.reason)
        assertEquals(TransferProof.BYTES, sameSize.bytes)
        assertEquals("size", TransferProof.download(response("ё".repeat(TransferProof.BYTES))).reason)
    }

    @Test fun sendingBytesIsNotSuccessWithoutServerSizeAndDigestAcknowledgement() {
        val payload = TransferProof.uploadPayload()
        assertEquals(TransferProof.UPLOAD_BYTES, payload.size)
        assertArrayEquals(payload, TransferProof.uploadPayload())
        val exact = obj("bytes" to payload.size, "sha256" to TransferProof.digest(payload)).toString()
        val passed = TransferProof.uploadAcknowledged(200, exact, payload, 50)
        assertEquals("pass", passed.state)
        assertEquals(payload.size, passed.bytes)
        assertEquals(50L, passed.elapsedMs)
        for (body in listOf("", "OK", "{}", obj("bytes" to payload.size, "sha256" to "wrong").toString(),
            obj("bytes" to payload.size - 1, "sha256" to TransferProof.digest(payload)).toString())) {
            assertEquals("fail", TransferProof.uploadAcknowledged(200, body, payload, 50).state)
        }
        assertEquals("fail", TransferProof.uploadAcknowledged(204, exact, payload, 50).state)
        assertEquals("fail", TransferProof.uploadAcknowledged(200, exact + " ".repeat(4096), payload, 50).state)
    }
}
