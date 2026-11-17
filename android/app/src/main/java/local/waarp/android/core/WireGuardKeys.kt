// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core

import local.waarp.android.core.crypto.Curve25519
import java.security.SecureRandom
import java.util.Base64

/** Deliberately not a data class: toString must never expose a private key in logs. */
class WireGuardKeyPair(val privateKey: String, val publicKey: String) {
    override fun toString(): String = "WireGuardKeyPair(privateKey=[redacted], publicKey=$publicKey)"
}

object WireGuardKeys {
    fun generate(): WireGuardKeyPair {
        val privateBytes = ByteArray(32)
        try {
            SecureRandom().nextBytes(privateBytes)
            privateBytes[0] = (privateBytes[0].toInt() and 248).toByte()
            privateBytes[31] = ((privateBytes[31].toInt() and 127) or 64).toByte()
            return WireGuardKeyPair(Base64.getEncoder().encodeToString(privateBytes), publicFromBytes(privateBytes))
        } finally { privateBytes.fill(0) }
    }

    fun publicKey(privateKey: String): String {
        val bytes = Base64.getDecoder().decode(privateKey.trim())
        try {
            require(bytes.size == 32) { "Ключ WireGuard должен содержать 32 байта" }
            return publicFromBytes(bytes)
        } finally { bytes.fill(0) }
    }

    private fun publicFromBytes(privateBytes: ByteArray): String {
        val result = ByteArray(32)
        try {
            Curve25519.eval(result, 0, privateBytes, null)
            return Base64.getEncoder().encodeToString(result)
        } finally { result.fill(0) }
    }
}
