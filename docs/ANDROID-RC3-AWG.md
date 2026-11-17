# Android 0.5.0-rc.3: AmneziaWG connectivity corrections

## User report and scope

The physical Android test reported a responsive application and working UI, but
an imported Amnezia profile transferred only a small number of bytes and did not
connect Telegram. The same configuration worked in the original Amnezia client.
Both whole-device and Telegram-specific routing were affected. The retained
screenshot shows WireGuard handshake initiation and a 15-second connection
timeout to a Telegram address. It does not show a successful handshake response.

The audit started from `main` commit
`4407c6b1cc635d71f42e937ba6374842bb49bfdd`. The correction changes the native UDP
fallback and one import branch. It does not replace the UI, routing policy,
TUN lifecycle, socket protection or the existing DNS recovery patch.

The audit also traced `AndroidPlatform.autoDetectInterfaceControl(fd)` through
the pinned engine's dialer and `UDPListenerControl()` into WireGuard's
`NewStdNetBind(listenerControl)`. Android `VpnService.protect(fd)` is present,
and a failed protection call raises an error. The accepted plain `.conf` path
preserves AWG parameters and interface host bits through native configuration.
These source checks found no missing protection callback or lost parameters;
they do not prove socket behavior on the user's phone. Runtime behavior when
Wi-Fi and cellular networks are both available remains part of the device test.

## Native UDP defects

Android uses the WireGuard fork pinned at
[`3ed047160c1454c513ddeacbf387daf3d480ff6d`](https://github.com/Leadaxe/wireguard-go-awg2-lx/tree/3ed047160c1454c513ddeacbf387daf3d480ff6d).
Two defects affect the fallback from UDP segmentation offload (GSO), whose
availability depends on the operating system, network driver and path:

1. `conn/bind_std.go` coalesces packets as multiple buffers in a message. After
   an offload error, the retry replaced only the first buffer and retained the
   others. An ordinary UDP datagram could therefore contain bytes from adjacent
   packets. The retry must contain exactly one buffer per original datagram.
2. `conn/errors_linux.go` downgraded offload only for `EIO`. The official Amnezia
   implementation also handles `EINVAL`, including when the segment size and
   headers exceed the path's fragment size. Otherwise the same unsupported
   offload operation can continue failing instead of using ordinary UDP.

The downstream patch changes only those two files. It keeps ordinary errors as
errors, disables offload only for the affected address family, and retains the
existing bounded retry. It does not disable GSO unconditionally or change AWG
keys, obfuscation parameters, MTU or server addresses.

These are reproducible native defects and credible explanations for differences
between an emulator and a physical phone. The screenshot alone cannot establish
which kernel error occurred on the user's device. A successful update test on
that device with the original server remains necessary to close that incident.

## Amnezia container import

Official Amnezia exports can store `last_config` as JSON text whose `config`
member contains the INI profile. The Android importer previously detected
`[Interface]` inside that JSON string before parsing the JSON, and passed the
entire wrapper to the INI parser. JSON wrappers are now unwrapped first.

The new regression preserves the private/public keys and PSK, host addresses
with their CIDR bits, DNS, MTU, listen port, peer endpoint, allowed IPs,
keepalive, J/S/H fields including unsigned 32-bit values/ranges, and I1–I5
through import, persistence serialization and native configuration generation.
Existing size/depth limits and explicit rejection of unsupported fields remain.
This separate import defect does not by itself explain an already accepted
plain `.conf` that times out during a handshake.

## Verification

- **Import regression:** before the correction, 15 of 16 importer tests passed;
  the real nested `last_config` fixture failed. After the correction all 16 pass.
- **Android JVM suite:** 124 passed, zero failures or skips. Debug application
  Kotlin/Java and Android instrumentation Kotlin compilation also passed.
- **Android lint:** `lintDebug` and `lintRelease` passed with zero errors.
  Existing dependency-version and Compose-style warnings remain (six debug,
  five release, plus one hint in each variant).
- **Actual debug APKs:** `assembleDebug` completed for `arm64-v8a`,
  `armeabi-v7a` and `x86_64`, all version `0.5.0-rc.3-debug`, code `4`.
  `scripts/android-verify.py --expect debug` passed for every APK: package
  identity, signatures, native byte hashes, source/license inventory and ZIP
  alignment. The two 64-bit ABIs also passed the ELF 16 KB/RELRO checks; the
  32-bit ABI retains its expected 4 KB ELF alignment.
- **Native UDP regression:** on the exact parent engine dependency graph and
  Go 1.26.10, the unpatched code fails both `EIO` and `EINVAL` cases. A real
  loopback receiver gets 160 bytes instead of the first 64-byte datagram in the
  former; the latter returns `invalid argument` without retry. Both pass after
  the patch, including the next send through the same bind. The `EPERM` control
  stays an error without downgrade. All two top-level tests and both required
  subtests pass with the race detector, with zero failures/skips.
- **Retained native DNS suite:** all 30 top-level tests and four subtests pass
  with the race detector, including all 14 downstream DNS recovery regressions.
- **Independent protocol interoperability:** the exact pinned client fork was
  exercised over real loopback UDP against official AmneziaWG
  [`v0.2.19`, commit `1cc94272ca8e9e223a5fe76382f5880f09d3c12d`](https://github.com/amnezia-vpn/amneziawg-go/tree/1cc94272ca8e9e223a5fe76382f5880f09d3c12d),
  using fresh synthetic keys and PSK. AWG1 and AWG2 each passed two fresh-client
  cycles, 24 encrypted DNS replies and two verified HTTP responses totaling
  131,148 bytes. The scenarios include H values above `2^31`; AWG2 also includes
  S1–S4 and CPS decoys. Wrong PSK and wrong H1 controls produced no authenticated
  handshake, DNS replies or HTTP response. These tests used ordinary loopback
  UDP and Go 1.26.11; they do not establish Android GSO or physical-network behavior.

The native fallback regression runs through the parent engine module, with the
same replaced WireGuard source and dependency versions as the AAR. Running it
from the submodule's older standalone `go.mod` would not establish this match.
The source builder requires both native suites before compiling the three ABIs.
Physical-device retest and the full Android release workflow are separate from
local parser/host tests. Do not use previous
rc.2 UI or soak results as proof that this candidate connects to the user's
server.

The Windows APK builder also passes 28 offline self-checks under PowerShell 7.7.0
on Linux. Windows PowerShell coverage is wired into the Windows CI job; a Linux
run is not reported as a completed Windows run.

## Build identity and retest

The application version is `0.5.0-rc.3`, version code `4`. Its native engine is
`1.14.4-lx.35-waarp.2`; the application checks that version at runtime. The AAR
and per-ABI SHA-256 values are in
`android/app/src/main/res/raw/engine_integrity.json`. The source manifest also
locks the WireGuard patch and regression source. An old `.1` AAR is not a valid
input for this APK, even if its Java API is unchanged.

The source build completed for all three shipped ABIs with the pinned Go, JDK,
NDK and SDK. Native static checks and the 112-module license/dependency inventory
passed. The AAR is 249,432,428 bytes, SHA-256
`1edc7454a993ad72de084e294c16a87797a1a8d1a51a7ee2b71fec6802245eaf`.
Its source-input SHA-256 is
`fb3201511b806d7f277daf8aba4ff155770ccbb56e93c37222468e59ba1e1c49`.
The nested Java archive is byte-identical to the previous engine; the corrected
code is in the native libraries. A separate CI source build must reproduce these
frozen bytes; merely changing the version string would not satisfy the pin.

`build.bat apk` checks the local AAR against the new pin before building and can
replace an old engine from a verified CI archive. Private repository lookup uses
existing GitHub API credentials when available; otherwise it opens Actions in
the user's browser and accepts only a matching downloaded archive. An uploaded
build artifact is usable while the independent soak job continues. API denial
is not reported as proof that no CI artifact exists.

Install the APK as an update with the same package and signing key. Test the
existing profile first, with the original Amnezia client stopped: whole-device
routing, then the Telegram route. Successful packet counters alone are
insufficient; require Telegram to connect and exchange messages. If it still
fails, retain the log from connection start through the first timeout, including
handshake and socket-send errors. Do not include private keys or complete
subscription links in an issue.

## Primary sources

- [Pinned WireGuard send/coalescing implementation](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/3ed047160c1454c513ddeacbf387daf3d480ff6d/conn/bind_std.go).
- [Pinned WireGuard Linux error policy](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/3ed047160c1454c513ddeacbf387daf3d480ff6d/conn/errors_linux.go).
- [Official Amnezia Linux GSO error handling](https://github.com/amnezia-vpn/amneziawg-go/blob/1cc94272ca8e9e223a5fe76382f5880f09d3c12d/conn/errors_linux.go).
- [Official Amnezia `last_config` serialization](https://github.com/amnezia-vpn/amnezia-client/blob/5aff2ce5809514ef7c292ac5e7ed3758d7d0b333/client/core/models/protocols/awgProtocolConfig.cpp).
