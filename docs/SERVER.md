# Own server: protocols, deployment and mobile findings (2026-11-17)

This describes how a personal Waarp server is set up and what was measured on it from
Russia on 17 November 2026. Addresses, domains and keys are deliberately absent:
`SERVER_IP` and `DOMAIN` stand for your own values. Never commit generated links,
`secrets.json` or client configs.

## 1. What runs on the server

Two containers with host networking, created by [`scripts/server/proxy-deploy.py`](../scripts/server/proxy-deploy.py),
next to an existing AmneziaWG interface (`awg-quick@awg0`) and an existing web server on TCP 443.
TCP 443 is not touched: the web server keeps it and REALITY uses other ports.

| Inbound | Port | Engine | Notes |
|---|---|---|---|
| AmneziaWG 2.0 | UDP 51821 | kernel `awg0` | clients added with [`awg-add-client.sh`](../scripts/server/awg-add-client.sh), no restart |
| VLESS + REALITY + Vision, foreign SNI | TCP 2083 | sing-box | cover `www.microsoft.com` |
| VLESS + REALITY + Vision, own domain | TCP 2087 | sing-box | cover = `DOMAIN` (the site on this IP) |
| VLESS + REALITY + Vision, Russian SNI | TCP 2096 | sing-box | cover `vk.com` |
| VLESS + XHTTP + REALITY | TCP 2443 | Xray | `mode=auto`, random path |
| VLESS + gRPC + REALITY | TCP 2098 | Xray | random service name |
| Hysteria2 + salamander | UDP 443 | sing-box | Let's Encrypt cert of `DOMAIN` |
| TUIC v5 | UDP 8443 | sing-box | same cert |
| Trojan TLS | TCP 2053 | sing-box | same cert |
| Shadowsocks-2022 | TCP+UDP 8388 | sing-box | baseline only |

Hysteria2, TUIC and Trojan need a real certificate: the Android importer refuses `insecure`
and certificate pins, by design. Images are pinned (sing-box `v1.14.4`, Xray by digest; Xray
26.11.9 at the time). The sing-box server must be 1.14.x: a 1.12 server rejected REALITY
handshakes of the 1.14 client ("processed invalid connection").

### Deploy

```bash
scp scripts/server/proxy-deploy.py root@SERVER_IP:/root/
ssh root@SERVER_IP 'python3 /root/proxy-deploy.py --host SERVER_IP --domain DOMAIN --client phone'
```

Secrets are generated once into `/opt/waarp-proxy/secrets.json` (mode 600) and reused on every
re-run, so imported links stay valid. One share link per inbound is written to
`/opt/waarp-proxy/clients/<inbound>.txt`. Configs are backed up before each rewrite.

New AmneziaWG client without restarting the interface:

```bash
ssh root@SERVER_IP 'bash /root/awg-add-client.sh phone 10.9.9.8 SERVER_IP'
```

### Check the links from a PC

```bash
ssh root@SERVER_IP 'cat /opt/waarp-proxy/clients/*.txt' | python scripts/server/test-links.py --engine engine/sing-box.exe -
```

Prints, per link, the HTTP 204 result, time and exit IP through the local engine. A link that
only fails here is a server or link problem; one that passes here but fails on a phone is a
network or client problem.

## 2. Measurements, 17 November 2026

Phone: Xiaomi Redmi Note 12, Android 15. Networks: home Wi-Fi (Rostelecom) and Beeline LTE.
Mobile results were taken only after the operator's balance block was lifted (see §3).

### Home Wi-Fi (Rostelecom)

- Plain WireGuard: the first handshake passes, then the flow is dropped in both directions.
- AmneziaWG 2.0: stable, Telegram works.
- All nine inbounds above: HTTP 204 through the server from the PC.
- Cloudflare WARP over MASQUE: registration API unreachable; HTTP/2 tunnel connects and
  freezes within seconds; HTTP/3 does not connect.

### Beeline LTE, official sing-box 1.14.4 on the phone (no VPN app)

Real transfers through each protocol (5 MB down, 2 MB up); plain mobile speed was about 7.7 Mbit/s.

| Protocol | Handshake | 5 MB down | 2 MB up |
|---|---|---|---|
| REALITY (any of the three covers) | yes | 7-8 Mbit/s | 6-7 Mbit/s |
| Hysteria2 | yes | 2.2 Mbit/s | 8.6 Mbit/s |
| TUIC | yes | 2.3 Mbit/s | 5.2 Mbit/s |
| Trojan TLS | yes | 1.1 Mbit/s | 8.9 Mbit/s |
| gRPC + REALITY | no | - | - |
| Shadowsocks-2022 | yes | fails | 0.4 Mbit/s |
| MASQUE / WARP (usque) | no | - | - |

XHTTP is not in the official build and was not measured this way.

### Beeline LTE, Waarp

REALITY stalled in Waarp while the same link worked with official sing-box. Packet captures on
the server showed the client sending exactly the first 1024 bytes of the TLS ClientHello and
nothing else; the server waited and closed the connection as invalid.

Cause: Waarp defaulted VLESS to the `firefox` uTLS fingerprint. In the pinned core
(`1.14.4-lx`) that hello carries a post-quantum key share and is about 1.9 KB, so it needs two
TCP segments, and Beeline drops the second one. Hello sizes measured with the same core:

| Fingerprint | ClientHello |
|---|---|
| firefox | 1892 B |
| chrome | 1823 B |
| randomized | 1560 B |
| safari | 1540 B |
| ios, edge, qq | 517 B |

With `fp=ios` the same profile works in Waarp on Beeline (Telegram connected, no engine errors).
Fix: the default fingerprint for VLESS links without `fp` is now `ios` on Android
(`ProfileImporter.DEFAULT_FINGERPRINT`) and desktop (`DEFAULT_FP`); an explicit `fp` is kept as is,
an empty `fp=` gets the default. The desktop network tune now tries `ios` and `edge` first.
Server links are generated with `fp=ios`.

## 3. Pitfalls met while measuring

- **Operator balance block looks like DPI.** With an empty balance Beeline redirects
  `generate_204` to `balance.beeline.ru`, keeps Gosuslugi reachable, accepts TCP connects and
  passes no data. Every protocol then "fails" the same way. Android's own probe shows it: the
  mobile network carries `CAPTIVE_PORTAL` and `NetworkMonitor` logs the redirect.
- **Short checks are not transfer checks.** Handshakes and URL tests passed while the data path
  was stalled. Measure a sustained transfer in both directions, as in the table above.
- **adb shell traffic follows the VPN.** With Waarp running, `uid 2000` is routed into `tun0`;
  turn the VPN off before measuring the bare network from the shell.
- **Debug builds mirror the engine log to logcat** (tag `waarp-core`), so a phone can be traced
  over adb without exporting a report.
