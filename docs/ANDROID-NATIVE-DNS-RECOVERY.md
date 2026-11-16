# Android native DNS recovery

## Evidence and scope

The API 29 instrumentation job for source `93b5385712d0257282d6c5bf12fe0a859041d2b6` failed the second OFF/ON DNS exchange. The retained assertion identifies `cycle=1`, a probe `SocketTimeoutException`, and native `example.com` telemetry reporting `use of closed network connection`. The independent AWG2 peer sent the encrypted answer, but the pending native DNS operation had already completed with an error.

- [Original Android run](https://github.com/INNVoices/waarp/actions/runs/43963216640).
- [Original API 29 runtime artifact](https://github.com/INNVoices/waarp/actions/runs/43963216640/artifacts/14276640192).
- [Read-only inspection of the retained artifact](https://github.com/INNVoices/waarp/actions/runs/43967108386/job/133649315401).

The inspection verified the downloaded ZIP size of 1,549,934 bytes and SHA-256 `94e76adba057f8fe377ede0d443b878e20f98857f9b21acfadfd539c1ed97489` against the source-bound artifact metadata. It did not rerun application tests.

At the pinned upstream source, both pool reset and terminal close used `net.ErrClosed`. Reset canceled pending UDP exchanges. A later transport handshake could not deliver a reply to the removed operation. The evidence does not establish which physical-network callback triggered the reset; increasing EDNS receive size can also reset the shared pool. The correction therefore handles the proven pending-operation failure and leaves Android physical-network selection intact.

Primary source: [sing-box-lx at f1bac271](https://github.com/Leadaxe/sing-box-lx/tree/f1bac271853eaf13398ce1030c948aebc3aed2e1), especially `dns/transport/{conn_pool,multiplexer,udp}.go` and `route/dns.go`.

## Recovery contract

The downstream source patch is `android/native-patches/dns-transient-reset.patch`. It is applied only to the locked upstream revision.

1. A pool reset has a distinct cause which still supports `errors.Is(err, net.ErrClosed)`. Terminal close retains its meaning.
2. UDP may replay a closed-connection exchange at most twice at the transport boundary, retaining the original request context, deadline, DNS transport and destination. Reset during shared acquisition returns to this same budget.
3. User/service shutdown marks the transport closed, cancels outstanding exchanges and joins in-flight dial operations. It cannot turn into another connection attempt after close returns.
4. Responses must belong to their connection. Cancellation and write-failure callbacks also identify the exact pending operation. A retired operation cannot consume a newer query or invalidate its shared connection after 16-bit identifier reuse.
5. Original cancellation, timeout, other network errors and DNS error responses do not receive a new retry deadline.

Truncated UDP responses still fall back to TCP, and cancellation closes the fallback socket. Unrelated pool users retain their policies. The patch does not change route selection, shared Android DNS policy, the separate probe application's single UDP query, its receive timeout, or the Android acceptance assertions.

The native regression file exercises the actual UDP transport and DNS codec with controlled packet connections. It covers reset before response and during dialing, retry-budget exhaustion, original cancellation/deadline, OFF during a pending query and a blocked replay dial, old responses, cancellation callbacks and late write errors after identifier reuse, concurrent requests, TCP fallback cancellation, and ownership cleanup. These deterministic native tests complement the encrypted Android-to-peer tests; they do not replace them.

## Source and binary integrity

The Android fork version is `1.14.4-lx.35-waarp.1`. The source lock records the upstream revision, four required gitlink revisions, patch/test hashes, Go, gomobile, JDK, NDK, SDK bootclasspath and the complete Android feature-tag set.

The source builder invokes pinned gomobile directly. This avoids the upstream wrapper's preference for a different installed NDK, `gomobile init` installing an unpinned gobind, and automatic selection of the newest installed Android bootclasspath. It builds the three shipped ABIs and the main API 24 native variant. The app minimum remains API 29.

AAR and nested Java archive entries use sorted names, fixed headers and stored ZIP entries. This makes container bytes independent of a host deflate implementation. Native ELF bytes must still reproduce from a separate source build. The production engine integrity file locks the actual AAR size/SHA-256 and each ABI's ELF bytes; it is not synthesized from the old binary.

Bootstrap output is a candidate for review. It cannot overwrite the production engine pin or license assets, create an approved APK, or establish release stability. Existing dependency notices may be carried forward only after exact native module and replacement identities match the previous inventory; new dependencies require a fresh notice audit.

## First native execution

[Native source audit 43971202163](https://github.com/INNVoices/waarp/actions/runs/43971202163) completed successfully for source `a6438d72432433bd8be934e96819bf7ea60ae44e`. The build gate required all 14 downstream top-level tests, both sync/async reset subtests and both retry-budget subtests to run and pass under the race detector, with no skipped or failed transport tests.

The candidate AAR is 249,431,020 bytes with SHA-256 `562afef9bcdbb37bc6069cdc247f821324d5be3471242f6eee136ff3883f2fb7`. Its source-input SHA-256 is `b9eecf6fd8b9584b1da6c09989945a3398ab78ca9750f939235d421d083e01db`; the nested Java archive is `d15ef5430296ec0315486cc3bba108660a77bf09b35a2b47c65f4345c6e51302`. The retained [candidate artifact](https://github.com/INNVoices/waarp/actions/runs/43971202163/artifacts/14280145662) contains the raw native test events, static ABI checks, source provenance and corresponding AAR.

This first execution supplies the production pins. Independent binary reproduction and Android runtime approval still require the full feature-branch workflow on the frozen inputs.

## Separate Android 10 consent correction

The same API 29 suite retained a visible, focused `com.android.vpndialogs/.ConfirmDialog` with one enabled positive button. The previous test helper required the entire raw button rectangle to be contained in the window rectangle. Floating-window surface insets can clip those reported bounds.

The helper now chooses the nonempty intersection of the button, focused window and screen, following AndroidX visible-coordinate handling. It still verifies the exact system component/package, one focused window, one positive button, class, visibility, enabled/clickable state and 250 ms of stationary raw and visible bounds. It injects one click, and authorization uses the remainder of the original ten-second deadline. Failure capture includes bounded raw predicate metadata without profile data or text fields.

Primary reference: [AndroidX AccessibilityNodeInfoHelper](https://github.com/androidx/androidx/blob/9bfa97378c52ccb1f5352195d89df1af0a87a110/test/uiautomator/uiautomator/src/main/java/androidx/test/uiautomator/AccessibilityNodeInfoHelper.java).

The debug runner also preserves a compact, redacted assertion header before its bounded native-log tail. This prevents a long native dump from hiding the failed cycle and probe error again.

## Approval

Use the release criteria in [ANDROID.md](ANDROID.md). Approval requires passing native regression results, actual APK integrity checks, JVM/lint results, all six short Android gates, the complete two-hour optimized-release AWG2 soak, and desktop regression gates for the same candidate source. A patch, a successful build or an earlier release run alone does not establish that approval.
