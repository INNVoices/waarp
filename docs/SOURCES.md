# Public catalog sources

The public catalog is optional and low-trust. It downloads public node lists at runtime; nothing is bundled.
Nodes from these lists are run by unknown third parties. **Waarp does not operate, vet or endorse them.** A node
operator can see connection metadata and can read or log any traffic that is not end-to-end encrypted (plain
HTTP, DNS without encryption, etc). Public nodes never join Auto or a fallback on their own; the user adds them
by hand. Do not use them for passwords, banking or anything personal.

Default sources (`DEFAULT_SOURCES` in `src/main/catalog.ts`). A source without a clear license or terms is not a
default.

| label in UI | source | license / terms | purpose |
|---|---|---|---|
| Awesome VPN | github.com/awesome-vpn/awesome-vpn (`all`) | GPL-3.0 (repository) | mixed public V2Ray/Xray nodes |
| V2Ray Configs | github.com/mrdevmohamed/v2ray-configs (`All_Configs_Sub.txt`) | GPL-3.0 (repository) | mixed public nodes |
| Epodonios | github.com/Epodonios/v2ray-configs (`All_Configs_Sub.txt`) | GPL-3.0 (repository) | mixed public nodes |
| Russia checked | github.com/igareck/vpn-configs-for-russia (`BLACK_VLESS_RUS.txt`, `BLACK_SS+All_RUS.txt`) | GPL-3.0 (repository) | nodes the list author checks from Russia |
| VPN Gate | www.vpngate.net (`/api/iphone/`) | VPN Gate public service terms | volunteer-run OpenVPN servers, see below |

Removed in RC2 (no license file in the checked repository state, reuse permission not established):
`ebrasha/free-v2ray-public-list`, `PlanAslii/vira-v2ray-configs`, `morpheusadam/v2ray-config`.

## VPN Gate

VPN Gate (University of Tsukuba research project) is a separate public service with its own operator and
privacy behavior. Its servers are run by volunteers. VPN Gate and the volunteer servers may keep connection
logs (source IP, time, amount of traffic) according to VPN Gate's own policy. Waarp only reads the public server
list and shows those servers as public nodes; it does not send VPN Gate anything beyond that list request.

## Changing the list

Before adding a default source record: repository/service URL, license or terms (with a link), and purpose.
