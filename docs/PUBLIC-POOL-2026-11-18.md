# Persistent public-node pool and catalog recovery

This update expands public candidates on Windows and Android and preserves them when list publishers are
unreachable. It builds on main `7bc2a1a89dc344dea0cf8a3268a4c0e3f4c747fd`, including the independent UI and
master-only TUN lifecycle changes. Public-list work does not start, stop or restart the main TUN, change an
application's route, or silently replace an existing public group.

## Sources and saved candidates

The registry contains seven feeds: Awesome VPN, mrdevmohamed, Barry, Mahdibland's public group, two igareck
feeds, and VPN Gate. Barry and Mahdibland are new defaults; the unavailable Epodonios feed is removed.
The two igareck feeds have explicit publisher-documented GitLab, Codeberg and Gitea mirrors. Publication
provenance, exact URLs and exclusions are recorded in [SOURCES.md](SOURCES.md).

Mirrors retain one logical source identity. Aggregators overlap, and source count does not establish
independent servers or providers. The client accepts supported share links/base64 and VPN Gate CSV; it does
not activate a downloaded client configuration, routing table, DNS policy or script.

Windows keeps up to 10,000 candidates in the encrypted catalog, bounded by profile and aggregate byte limits.
Android retains up to 2,000 candidates within its existing encrypted AppData limit. These are capacity limits,
not promises that a particular number of servers is available. Full effective configuration identity is used
for deduplication. Existing saved IDs remain bound to their original configuration; a change to credentials,
SNI or transport path must not redirect an old card to another server.

Ingestion merges new results with the previous pool. Empty, blocked, malformed and partially failed sources
cannot erase useful previous candidates. Source interleaving prevents one large feed from taking all input capacity. Windows also interleaves
protocols during ingestion; Android applies protocol diversity when choosing a group. Eviction leaves room for new candidates while protecting recent useful history.

## A saved record is not a working connection

Windows exposes `readyCount`, stored candidate count, up to 50 diverse fresh results and a bounded preview
of 200 candidates that are not currently ready. Historical latency is not displayed as a current successful
measurement. The ready state lasts five minutes, belongs to this process/network context and is invalidated
on a detected network change or sleep/resume. Restarting the application restores candidates without restoring
their old ready flag. Android expires public observations by physical network handle and the same five-minute
window. Neither platform equates publisher labels or HTTP 200 from a list host with relay availability.
Ready records describe the existing HTTPS probe, not every website, UDP support, sustained speed or a promise
that an established connection will survive switching servers. Multiple checked public IPs for one hostname
are currently narrowed to one temporary dial address per attempt; an unreachable first address can therefore
produce a negative result even when another address would work.

On Windows, **Update** downloads lists while ON through existing diagnostic paths; while OFF it can also run
a bounded verification round. **Check pool** advances through saved candidates without downloading a list.
Up to 64 candidates enter a round in batches of eight. A persisted verification cursor prevents repeated
checks from being limited to the same initial rows. Actual failures back off from 30 seconds up to six hours;
a different network clears the applicability of those cooldowns. Successful observations are committed only
after checker cleanup has been confirmed. Android keeps its explicit bounded check/group action and existing
round-robin sample mechanism.

The suggested group prefers different endpoint hosts and protocols; Android also uses subnet/country hints.
These heuristics do not claim ASN/operator independence. The resulting group is an additional choice. The
user still selects where to use it. Cached candidates can be selected manually with their unverified status
visible.

## Windows public-list recovery

Public-list downloads use a bounded reserve of paths, separate from private subscription downloads:

1. Prefer the explicitly selected service connection and the last successful public-list path.
2. Allocate remaining slots between saved connections and cached candidates, diversifying endpoint hosts.
3. Keep a few useful historical candidates and advance a separate persisted recovery cursor for the rest.
4. Retry only missing logical sources; retain sources already received successfully on a previous path.

The budget is at most eight paths, 18 seconds per attempt and 90 seconds for the recovery round, followed by
verified cleanup if a checker was owned. If the selected service path is personal, the operation does not
silently try Direct. Direct is eligible only when the user's service preference is Direct. ON uses only IDs
actually loaded in the current engine and its separate diagnostic selector. It cannot add an outbound or
recreate TUN. OFF can lease the existing headless checker with no TUN inbound. A failed shutdown is terminal:
no second path or catalog checker starts until runtime recovery has verified cleanup.

Selected-path DNS can try Cloudflare and Google DoH through that same proxy, with fixed bootstrap addresses,
verified TLS hostnames and bounded public-address validation. It cannot fall back to a system socket. The
private `withServiceTransport` path and its single selected connection are preserved. Fetching a public list
through a candidate is useful delivery evidence, but does not promote the candidate into the general ready
list.

## Untrusted endpoint boundaries

Source requests require bounded HTTPS responses, registered delivery hosts, public DNS answers, IP-pinned
TLS connections and checked redirects. A source returning HTML, empty data or full application JSON/YAML
does not count as a successful mirror.

Relay endpoints are checked separately. Loopback, private/local addresses and ambiguous local hostnames are
rejected, including legacy cache records and all OpenVPN remotes. Before an automatic OFF check or Windows
recovery attempt, domain endpoints are resolved once and pinned in a temporary checker configuration; the
stored hostname, credentials and ID are preserved. An unsafe DNS set rejects the entire candidate. Protocol
identity, TLS SNI and explicit HTTP authority must survive pinning; when that cannot be established, the
candidate is skipped without a false OK or DOWN observation. ON automatic recovery uses a loaded public
configuration only if every dial endpoint is already a public IP literal. Personal configurations retain
their original semantics.

## Android boundary and remaining work

Android receives the source registry, mirrors, strict source policy, persistent merged pool, honest freshness,
diverse groups and safe temporary public checker endpoints. Its catalog fetch uses the selected service
network through the existing Android socket binding. It does not silently change that preference.

Independent recovery through arbitrary cached Android nodes is **not implemented** here. The pinned native
`GetURLViaOutbound` HTTP API follows redirects without exposing each redirect for source-policy checks, and
the Android runtime has no equivalent authenticated local HTTP proxy capability. This update does not weaken
those checks or change the native engine/TUN to simulate parity with Windows. A safe per-outbound native fetch
or proxy capability is a separate prerequisite.

Community publication, signed source manifests and a signed application/release update transport are also
separate work. Catalog recovery in this patch does not claim to implement a GitHub release updater. A first
installation with all bootstrap hosts blocked and no reachable personal/cached path still needs an imported
configuration or another available delivery path. No public pool can guarantee access under every network
block.

## Verification

All new loader, pool, endpoint, recovery-path and owner-lifecycle tests use synthetic responses and local
fixtures. They do not contact public relay servers or modify host routes. Windows native checks and the
browser regressions run in the repository's disposable CI environment. Local browser execution in this
workspace was blocked by the environment's AF_UNIX socket restriction and is not recorded as a pass.

The normal desktop gates are `npm run typecheck`, `npm test`, `npm run check`, `npm run build` and
`npm run test:ui`. New DOM cases cover stale latency, explicit cached-node selection, ON list refresh and OFF
verification without a toggle. Android catalog/policy tests run with the existing JVM unit-test task;
standalone Kotlin/JUnit checks cover the pure production importer/catalog/policy code without requiring a
device or network. The Android CI job remains responsible for full app compilation, lint and package checks.
