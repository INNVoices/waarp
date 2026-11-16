# Pinned AWG userspace library probe

This is an opt-in diagnostic harness, separate from the Waarp application runtime. It does not modify or replace the shipped engine, install a system TUN, change routes, request raw/network-admin access, or change sandbox policy. The replayable source lives under `test/userspace-awg`; compiler, module cache and binaries are excluded from the source deliverable.

## Why this exists

The pinned Linux sing-box executable starts a network monitor even when `route.auto_detect_interface` is false. Its monitor's `Start` error is fatal. The current host rejects the necessary netlink socket. The `RouteOptions` JSON contract has no option to suppress that monitor. This prevents a native sing-box integration run in this host.

The same pinned `wireguard-go-awg2-lx` library exposes `Device`, `tun.Device` and `conn.Bind` for embeddings. Its own tests use memory TUNs and alternative bindings. This harness implements a small ordinary-UDP binding and memory TUN through those public interfaces. It uses no `StdNetBind` wrapper or hidden type assertion, because that binding separately enables Linux sticky-route netlink monitoring.

Successful execution establishes a real authenticated AWG handshake and sends a DNS A query for `example.com` **inside that encrypted tunnel** to the first IPv4 DNS address in the supplied configuration. The outer transport is ordinary UDP. The report contains only booleans, counters and fixed error codes. Library logging is suppressed; raw UAPI contains secrets and is never displayed.

This tests the AWG library and server interoperability, not sing-box routing, Windows Wintun, Electron startup recovery, or whole-computer traffic policy.

## Version and sources

- Initial local evidence used Go 1.26.8. The replay/CI toolchain is now pinned to Go 1.26.11 in `go.mod`; each CI artifact retains `go version -m`. Historical verified compiler archive: official `go1.26.8.linux-amd64.tar.gz`, SHA256 `d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b`; [official archive metadata](https://go.dev/dl/?mode=json&include=all).
- AWG library: [`64065e6826ad82aa28429dd829c1c65f29b7f6c9`](https://github.com/Leadaxe/wireguard-go-awg2-lx/commit/64065e6826ad82aa28429dd829c1c65f29b7f6c9), module replacement fixed in `go.mod`; [MIT license](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/LICENSE).
- Its public [Bind contract](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/conn/conn.go), [TUN contract](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/tun/tun.go), [end-to-end memory transport tests](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/transport_padding_test.go) and [StdNetBind sticky route listener](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/sticky_linux.go) establish the embedding contract.
- Native sing-box behavior: [`route/network.go`](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/route/network.go), [`option/route.go`](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/option/route.go).
- `sing`, `x/crypto`, `x/net`, and `x/sys` versions are aligned to the [pinned engine module file](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/go.mod). No gVisor or other tunnel implementation is substituted.

## Scope and use

Requires a native, single-peer AWG/WireGuard `.conf`, at least one IPv4 interface address, an IPv4 DNS server covered by AllowedIPs and a literal-IP peer Endpoint. Other profiles are rejected with a fixed code. This narrow harness is not an additional product importer.

Build with Go 1.26.11 using `go build -trimpath -buildvcs=false -o awg-userspace-audit .`. Dependency versions and checksums are fixed in `go.mod` and `go.sum`.

### Local encrypted AWG lifecycle check

```sh
./awg-userspace-audit --self-test
```

This mode never reads a private configuration or contacts an external address. It first attempts exactly one ordinary loopback UDP exchange and stops if the host refuses it. It then creates two real Devices from the pinned library, fresh synthetic X25519 keys, synthetic AWG2 J/S/H/I parameters, and UDP sockets explicitly bound to `127.0.0.1`.

The synthetic server answers an inner DNS A query with a documentation-only address. The check requires authenticated handshakes and a decrypted DNS response at the client. It also observes the configured AWG handshake/data header ranges and padding offsets in the outer UDP datagrams and checks that those datagrams do not contain the plaintext DNS question.

Lifecycle checks are sequential: initial connection, client Down/Up, remove the client's peer and prove no DNS response, re-add that peer and restore DNS, close both devices, and recreate them with fresh keys on the **same UDP ports**. Positive exchanges each have an 8-second deadline; peer removal is observed for 1.5 seconds; device shutdown is bounded to 5 seconds.

For an independently controlled crash/restart experiment:

```sh
./awg-userspace-audit --self-test --hold 30s
```

After the lifecycle exchanges succeed this prints a JSON `holding_after_success` marker with only the two loopback port numbers, then holds the current devices open. A supervising process can SIGKILL this child and run a fresh self-test. `--hold` is limited to 60 seconds and is accepted only with `--self-test`. Interrupted runs do not print a completed success result. The Go code does not signal any other process.

The repeatable POSIX crash/restart supervisor is:

```sh
python3 crash-check.py --binary ./awg-userspace-audit --report crash-result.json
```

It launches exactly one owned `--self-test --hold 30s` child, waits up to 45 seconds for its holding marker, and verifies that binding **both** reported loopback UDP ports fails with `EADDRINUSE` while that child is alive. It sends SIGKILL only to that child, requires the `-SIGKILL` exit status, and verifies that binding both ports now succeeds. It then launches one fresh `--self-test` and requires `passed=true` and `stopped=true`.

All subprocesses and probe sockets are cleaned up in `finally`/context managers. Individual waits are limited to 45 seconds for self-tests and 5 seconds for exit/cleanup. The JSON report contains booleans, duration and fixed error codes, with no PID, port numbers, keys or private endpoint. The supervisor never accepts a private configuration or launches `--run`.

### Optional private-server check

Run `./awg-userspace-audit --config /path/to/private.conf` for the default **parse-only dry run**, which opens no sockets. Add `--run --timeout 20s` only for a separately authorized real-host test. The network phase is bounded to 30 seconds, with at most 5 seconds for device shutdown. `--self-test` cannot be combined with `--config` or `--run`.

No configuration or packet trace is written. Do not use `IpcGet` output as a report: it includes private data. The harness parses only its handshake timestamp in memory and outputs a boolean.

Source/build preparation and actual network results must be recorded separately. An authenticated handshake with no DNS answer does not establish general Internet connectivity; a DNS timeout alone does not prove that the server configuration is wrong.

## Preparation evidence

On 2026-11-16, the official Go archive matched the expected SHA256, module resolution completed, and the standalone binary built successfully. `go version -m` confirms Go 1.26.8 and the exact `wireguard-go-awg2-lx` replacement above, together with the pinned engine's sing/crypto/net/sys versions.

The supplied private file passed the default dry run: `config_valid=true`, `socket_opened=false`, zero transmitted/received datagrams and `stopped=true`.

The main audit then ran one authorized private-host attempt. Device configuration and UDP socket opening succeeded, but the host returned `network_unreachable` for outbound UDP: zero datagrams were sent or received, no handshake completed, and shutdown completed. The host was not retried. This is not evidence that the remote server or credentials are invalid.

The local `--self-test` subsequently **passed** in 6.617 seconds: real authenticated handshakes, encrypted DNS exchange, all lifecycle checks, AWG header/padding observations and plaintext exclusion. The two devices sent/received 66/66 outer datagrams, recorded zero device error events and stopped cleanly. These local results establish the pinned AWG implementation and lifecycle behavior in this environment; they do not replace an external-server or Windows routing test.
