# Android HTTP client: bounded headers and compromised CA rejection

## Findings and dependency choice

The release audit found two security concerns in the previously pinned OkHttp 5.3.2. Response-body byte limits do not constrain HTTP/2 header allocation before the response callback. Its HPACK dynamic-table limit also does not bound the accumulated decoded header list. Separately, a valid platform trust decision on an unupdated Android trust store can accept a chain containing one of the compromised eMudhra intermediate keys. Neither finding is a claim of an observed attack against Waarp.

The official [OkHttp changelog](https://github.com/lysine-dev/okhttp/blob/master/CHANGELOG.md) and the exact upstream changes provide the fixes:

| Change | Pinned upstream evidence | Application in Waarp |
| --- | --- | --- |
| Bound HTTP/2 header decoding | [`332f403e5bd55a601b8c04d9e69ad5ef64334b2e`](https://github.com/lysine-dev/okhttp/commit/332f403e5bd55a601b8c04d9e69ad5ef64334b2e), included in OkHttp 5.4.0 tag `61423f472da24e0ccc42b6a2c0863fb27932fea5` | Official Android artifact 5.4.0; its 256 KiB header budget applies during decoding, before body handling |
| Reject compromised CA keys | [`6db98026dfb817a23c0282aa4e53d8187b309052`](https://github.com/lysine-dev/okhttp/commit/6db98026dfb817a23c0282aa4e53d8187b309052), included in 5.5.1 | Eight exact SHA-256 SubjectPublicKeyInfo fingerprints, with source and Apache-2.0 attribution, adapted in `CompromisedCaGuard` |

Google's [incident explanation](https://blog.google/security/protecting-chrome-and-android-users-from-compromised-emudhra-intermediate-ca-certificates/) describes the compromised intermediate keys and trust-store mitigations. Waarp does not assume that a device has received that update or has Google Play services.

The official 5.5.1 Android AAR declares `minCompileSdk=37`; 5.4.0 declares `minCompileSdk=36`. The latter fits the retained SDK 36 toolchain. The JVM variant of 5.5.1 is not an Android substitute: its platform registry and TLS integration differ. The build neither suppresses the AAR metadata gate nor replaces Android trust handling. Exact resolved Maven components and their licenses remain recorded in the packaged runtime inventory.

## Guard placement and contract

The sole production `NetworkTools` OkHttp client installs `CompromisedCaGuard` as a network interceptor. In OkHttp 5.4.0, `ConnectInterceptor` establishes TLS and the existing trust/hostname checks before network interceptors run; `CallServerInterceptor` writes HTTP request headers afterward. The guard reads `Connection.handshake().peerCertificates`, whose lazy chain-cleaner result includes the validated chain, including certificates supplied by the trust manager. Inspecting only the raw SSL session peer list would miss such certificates. HTTP/2 connection preface and SETTINGS can precede the interceptor; the guarantee concerns request headers/body, not zero transport bytes before rejection.

For HTTPS, a missing connection/handshake, an empty chain or a non-X509 certificate fails closed. Every certificate's DER SubjectPublicKeyInfo is hashed and checked before `chain.proceed`. The production set cannot be removed through the internal additional-key parameter used by local fixtures. The change does not install a permissive trust manager, weaken hostname verification or create a user setting to bypass rejection. Existing HTTPS-only URL validation and manifest cleartext restrictions remain in force; the guard does not introduce a plaintext exception. Its HTTP passthrough behavior is exercised only as an isolated interceptor fixture.

## Verification and approval boundary

Local JVM regressions use actual loopback TLS sockets and synthetic certificates. These byte-counting fixtures negotiate HTTP/1.1 and exercise an ordinary trusted exchange, untrusted-root rejection, hostname mismatch, and blocked leaf/intermediate/root certificates before any HTTP request byte reaches the server. The server deliberately omits the trusted root, so root rejection also checks that the validated chain is used. The public compromised intermediate from the pinned upstream fixture checks the production blocklist itself; no compromised private key is required or included. Missing/empty HTTPS chain and cleartext behavior are covered separately.

Two further fixtures use the upstream MockWebServer 5.4.0 as a test-only dependency and require actual HTTP/2 negotiation. An ordinary response must first succeed; a subsequent aggregate header list exceeding 256 KiB must fail with the decoder's specific header-budget exception before a response is returned. A blocked validated root must fail with the guard's specific exception and produce no HTTP/2 request stream at the server. Connection preface/SETTINGS are outside that assertion.

After the fix, the exact production guard and all ten focused cases compiled with Kotlin 2.2.21 targeting JVM 17 and passed against OkHttp JVM 5.4.0 in 1.219 seconds, with no compiler diagnostics. This host check is separate from Gradle's Android variant and its platform trust manager; the full Android build and runtime jobs remain required.

These fixtures verify the focused HTTP change, not an Android release. The new APK must still pass Android compilation, lint, release optimization, the full short native/UI/release matrix and the actual two-hour AWG2 soak with the unchanged budgets. Historical passing APKs built with 5.3.2 cannot approve the new payload. Native-core source, dependency and binary pins remain unchanged.
