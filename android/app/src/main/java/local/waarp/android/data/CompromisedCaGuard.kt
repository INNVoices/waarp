/*
 * Copyright (c) 2026 OkHttp Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Adapted from OkHttp CertificateBlocklist.kt, commit
 * 6db98026dfb817a23c0282aa4e53d8187b309052 (CVE-2026-111943):
 * https://github.com/lysine-dev/okhttp/commit/6db98026dfb817a23c0282aa4e53d8187b309052
 * Waarp changes: check the cleaned, validated connection chain in a network
 * interceptor before sending HTTP headers; reject a missing or empty chain.
 */
package local.waarp.android.data

import java.security.cert.Certificate
import java.security.cert.X509Certificate
import javax.net.ssl.SSLPeerUnverifiedException
import okhttp3.Interceptor
import okhttp3.Response
import okio.ByteString.Companion.toByteString

/** Additional keys support local TLS fixtures; the production blocklist cannot be removed. */
internal class CompromisedCaGuard(additionalBlockedSpkiSha256: Set<String> = emptySet()) : Interceptor {
    private val blockedSpkiSha256 = COMPROMISED_SPKI_SHA256 + additionalBlockedSpkiSha256

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (request.url.isHttps) {
            // OkHttp 5.4 ConnectPlan supplies its lazy CertificateChainCleaner result here,
            // after platform trust and hostname checks. Network interceptors run before
            // CallServerInterceptor writes request headers. Reading a raw SSLSession's
            // peer list instead would miss intermediates supplied by the trust manager.
            checkValidatedChain(chain.connection()?.handshake()?.peerCertificates)
        }
        return chain.proceed(request)
    }

    internal fun checkValidatedChain(certificates: List<Certificate>?) {
        // Handshake turns a cleaner's SSLPeerUnverifiedException into an empty list.
        if (certificates.isNullOrEmpty()) {
            throw SSLPeerUnverifiedException("HTTPS certificate chain is unavailable")
        }
        for (certificate in certificates) {
            if (certificate !is X509Certificate) {
                throw SSLPeerUnverifiedException("HTTPS certificate chain is not X509")
            }
            val spkiSha256 = certificate.publicKey.encoded.toByteString().sha256().hex()
            if (spkiSha256 in blockedSpkiSha256) {
                throw SSLPeerUnverifiedException("HTTPS certificate chain contains a compromised key")
            }
        }
    }

    private companion object {
        // SHA-256 of DER SubjectPublicKeyInfo, not of the complete certificate.
        val COMPROMISED_SPKI_SHA256 = setOf(
            "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b",
            "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f",
            "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0",
            "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8",
            "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30",
            "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41",
            "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105",
            "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6",
        )
    }
}
