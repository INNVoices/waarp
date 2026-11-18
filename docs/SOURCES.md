# Public catalog sources

The public catalog is optional and low-trust. It downloads public node lists at runtime; relay configurations
are not bundled with Waarp. Nodes are run by third parties. **Waarp does not operate, vet or endorse them.** A
node operator can see connection metadata and can read or log traffic that is not end-to-end encrypted. Public
nodes enter application routing only after a user selects them; a newly downloaded list grants no permission
to change the user's routes.

## Registry and provenance

The authoritative desktop registry is [`src/shared/public-sources.ts`](../src/shared/public-sources.ts).
`DEFAULT_SOURCES` remains a `string[]` for existing callers and is re-exported by `src/main/catalog.ts`.
Each registered source has a stable ID, display name, expected format, primary URL, explicit mirror URLs,
publisher and provenance links. These are publication records, not health certificates.

The following repository licence files and publisher documentation were checked on **2026-11-18**. A licence
for repository material does not establish consent, ownership, safety or availability of every aggregated
relay. The two igareck lists share one publisher; mirrors share their original source identity. Other
aggregators can overlap heavily as well, so the number of feeds is not a count of independent reserves.

| Source ID | Publisher / primary subscription | Licence or public-service basis | Scope |
|---|---|---|---|
| `awesome-vpn` | [awesome-vpn/awesome-vpn](https://github.com/awesome-vpn/awesome-vpn), [`all`](https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all) | [GPL-3.0 repository licence](https://github.com/awesome-vpn/awesome-vpn/blob/master/LICENSE) | Retained mixed URI/base64 source |
| `mrdevmohamed` | [mrdevmohamed/v2ray-configs](https://github.com/mrdevmohamed/v2ray-configs), [`All_Configs_Sub.txt`](https://raw.githubusercontent.com/mrdevmohamed/v2ray-configs/main/All_Configs_Sub.txt) | [GPL-3.0 repository licence](https://github.com/mrdevmohamed/v2ray-configs/blob/main/LICENSE) | Retained mixed URI/base64 source |
| `barry` | [barry-far/V2ray-Config](https://github.com/barry-far/V2ray-Config), [`All_Configs_Sub.txt`](https://raw.githubusercontent.com/barry-far/V2ray-config/main/All_Configs_Sub.txt) | [MIT, copyright 2025 barry-far](https://github.com/barry-far/V2ray-Config/blob/main/LICENSE) | Additional mixed URI/base64 candidates |
| `mahdibland-public` | [mahdibland/V2RayAggregator](https://github.com/mahdibland/V2RayAggregator), [`Eternity.txt`](https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/Eternity.txt) | [GPL-3.0 repository licence](https://github.com/mahdibland/V2RayAggregator/blob/master/LICENSE) | Public group only; `EternityAir` trial/airport group is excluded |
| `igareck-vless` | [igareck/vpn-configs-for-russia](https://github.com/igareck/vpn-configs-for-russia), [`BLACK_VLESS_RUS.txt`](https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS.txt) | [GPL-3.0 repository licence](https://github.com/igareck/vpn-configs-for-russia/blob/main/LICENSE) | Regional publisher measurements; no promise for another country or ISP |
| `igareck-mixed` | Same publisher, [`BLACK_SS+All_RUS.txt`](https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_SS%2BAll_RUS.txt) | [GPL-3.0 repository licence](https://github.com/igareck/vpn-configs-for-russia/blob/main/LICENSE) | Additional supported URI protocols from the same publisher |
| `vpngate` | [VPN Gate](https://www.vpngate.net/en/), [official CSV](https://www.vpngate.net/api/iphone/) | Official site explicitly offers the CSV for third-party clients; [public-service policy](https://www.vpngate.net/en/about_abuse.aspx) | Volunteer OpenVPN relays; separate logging and availability limitations below |

Mahdibland's primary URL intentionally retains the previous repository name `ShadowsocksAggregator`: that is
the public-group endpoint documented by the publisher. Redirects are checked on every runtime request. A new
commit, a successful list download, and a successful local node check are separate events.

### Explicit mirrors

The igareck publisher documents the following exact URI-list mirrors in
[`MIRRORS.md`](https://github.com/igareck/vpn-configs-for-russia/blob/main/MIRRORS.md). Each row is one source,
not three new sources. The registry tries the primary, then GitLab, Codeberg and Gitea in that order.

| Source | GitLab | Codeberg | Gitea |
|---|---|---|---|
| `igareck-vless` | [raw list](https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/BLACK_VLESS_RUS.txt) | [raw list](https://codeberg.org/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_VLESS_RUS.txt) | [raw list](https://gitea.com/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_VLESS_RUS.txt) |
| `igareck-mixed` | [raw list](https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/BLACK_SS%2BAll_RUS.txt) | [raw list](https://codeberg.org/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_SS%2BAll_RUS.txt) | [raw list](https://gitea.com/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_SS%2BAll_RUS.txt) |

No mirror URL is synthesized from a hostname template at runtime. Mirror synchronization and reachability
from the user's connection are not assumed. There are no implicit translator, converter or arbitrary CDN
proxies. Unsupported or empty mirror responses cannot replace a useful previous catalog.

## What a successful download means

[`src/main/catalog-fetch.ts`](../src/main/catalog-fetch.ts) returns a separate result for each logical source:
canonical URL, optional source ID, the selected delivery URL, format and bounded attempt outcomes. These
describe **list delivery**, not whether any relay works from the user's current network.

An HTTP 200 response is accepted only after actual supported-format validation. Empty lists, HTML block
pages, malformed configs and full JSON/YAML client configurations fail validation and cause the next
documented mirror to be tried. URI subscriptions may be plain text or base64; comments and empty lines are
removed. The current catalog accepts supported VLESS, VMess, Trojan, Shadowsocks, Hysteria2 and TUIC share
links, plus VPN Gate CSV containing supported embedded OpenVPN profiles. Unsupported protocol links do not
gain support merely by appearing in a list. No downloaded routes, DNS rules, scripts or full client settings
are applied. Format acceptance requires a successfully parsed candidate; it does not make an endpoint alive.

Downloads are bounded to ten logical sources per call, three concurrent sources, three mirrors per source,
16 MiB per response, eight seconds per endpoint, 32 seconds per source and three redirects per endpoint.
The caller can cancel the whole operation, including stalled response bodies. A selected service transport
is retained for all mirrors in that call: this loader never silently retries through Direct. Failed sources
are returned individually so an orchestrator can retry only those sources through another permitted path.

Each request and redirect requires HTTPS, the source's registered hostnames, no URL credentials and the
standard HTTPS port. Existing unregistered raw GitHub/VPN Gate URLs retain the old host allowlist. DNS
answers are checked for private/local destinations and TLS sockets use the already checked IP addresses,
preserving the original TLS hostname. Selected-profile DNS follows the supplied service transport. Errors
never include response bodies or relay credentials.

## Excluded and deferred sources

- `Epodonios/v2ray-configs` was removed from defaults after the repository returned 404 in both the web lookup
  and GitHub API on 2026-11-18. This is an observed unavailable source, not proof of permanent deletion.
- `ebrasha/free-v2ray-public-list`, `PlanAslii/vira-v2ray-configs` and `morpheusadam/v2ray-config` remain outside
  defaults; reuse permission was not established during their previous review. Ebrasha also returned 404 in
  the current research snapshot.
- `mehrtat/vless-collector` and `nodesradar/nodesradar-en` remain research candidates because repository
  licence/provenance questions are unresolved. A useful checker implementation alone is not default approval.
- `Au1rxx/free-vpn-subscriptions` claimed hourly refreshes but its observed publication remained dated
  2026-10-30. `peasoft/NoMoreWalls` has separate restrictive use terms and is not enabled by this change.
- Raw HTTP/SOCKS scan lists and expiring trial-account feeds are not added to the default reserve.

## VPN Gate

VPN Gate is a University of Tsukuba academic project; individual relays are operated by volunteers, who
[explicitly enable public participation](https://www.vpngate.net/en/join.aspx). The
[official homepage](https://www.vpngate.net/en/) offers the CSV for building a client and warns that its
published list is partial. Publisher ping/score fields do not prove local device connectivity.

The [anti-abuse policy](https://www.vpngate.net/en/about_abuse.aspx) states that VPN Gate retains connection
logs for at least three months. Volunteer relay logging is also described by that policy. This is not a
no-log service. Fetching the catalog contacts the list publisher; when the user selects a relay, the user's
chosen traffic reaches that volunteer's server. Automatic list import does not remove these distinctions.

## Changing the registry

Before adding a default, record the publisher, stable ID, exact documented data endpoint, supported format,
licence or public-service basis with links, and the review date. Establish mirror provenance separately and
keep mirrors attached to their original source. Do not treat a repository licence as proof of individual
relay consent. Preserve attribution and recheck applicable terms if configurations are ever redistributed
or bundled rather than downloaded at runtime.

Add offline regression coverage for any new format or delivery behavior. `test/catalog-fetch.check.ts`
covers real format fallback, registered mirror identity, HTTPS/public-address guards, IP pinning, cancellation,
deadlines and byte/concurrency limits using synthetic HTTP/DNS responses. It never connects to public nodes
or changes the test machine's routes.
