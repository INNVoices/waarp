// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.data

import local.waarp.android.i18n.localized

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.net.InetAddress
import java.util.Base64
import kotlin.coroutines.coroutineContext

enum class PublicSourceFormat { URI_OR_BASE64, VPN_GATE_CSV }

data class PublicSourceProvenance(val kind: String, val publisher: String, val homepage: String,
    val license: String, val licenseUrl: String, val reviewedAt: String = "2026-11-18", val mirrorDocumentation: String? = null)

data class PublicCatalogSource(val id: String, val name: String, val format: PublicSourceFormat, val url: String,
    val mirrors: List<String> = emptyList(), val provenance: PublicSourceProvenance, val redirectTargets: List<String> = emptyList()) {
    val endpoints: List<String> get() = listOf(url) + mirrors
}

/** Catalog publication is provenance, not proof that a relay is owned by the publisher or works here. */
object PublicCatalog {
    const val MAX_SOURCE_BYTES = 8 * MAX_IMPORT_BYTES
    const val SOURCE_NODE_LIMIT = 1_000
    const val HEALTH_TTL_MS = 5 * 60_000L
    const val SOURCE_TIMEOUT_MS = 36_000L
    const val ATTEMPT_TIMEOUT_MS = 9_000L
    private val links = Regex("(?:vless|vmess|trojan|ss|hysteria2|hy2|tuic)://[^\\s\"'<>\\\\]+", RegexOption.IGNORE_CASE)
    private val igareckProvenance = PublicSourceProvenance("aggregator", "igareck",
        "https://github.com/igareck/vpn-configs-for-russia", "GPL-3.0",
        "https://github.com/igareck/vpn-configs-for-russia/blob/main/LICENSE",
        mirrorDocumentation = "https://github.com/igareck/vpn-configs-for-russia/blob/main/MIRRORS.md")

    // Keep IDs, formats, publication licences and documented mirrors in sync with src/shared/public-sources.ts.
    val SOURCES = listOf(
        PublicCatalogSource("awesome-vpn", "Awesome VPN", PublicSourceFormat.URI_OR_BASE64,
            "https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all",
            provenance = PublicSourceProvenance("aggregator", "awesome-vpn", "https://github.com/awesome-vpn/awesome-vpn",
                "GPL-3.0", "https://github.com/awesome-vpn/awesome-vpn/blob/master/LICENSE")),
        PublicCatalogSource("mrdevmohamed", "V2Ray Configs", PublicSourceFormat.URI_OR_BASE64,
            "https://raw.githubusercontent.com/mrdevmohamed/v2ray-configs/main/All_Configs_Sub.txt",
            provenance = PublicSourceProvenance("aggregator", "mrdevmohamed", "https://github.com/mrdevmohamed/v2ray-configs",
                "GPL-3.0", "https://github.com/mrdevmohamed/v2ray-configs/blob/main/LICENSE")),
        PublicCatalogSource("barry", "Barry V2Ray Config", PublicSourceFormat.URI_OR_BASE64,
            "https://raw.githubusercontent.com/barry-far/V2ray-config/main/All_Configs_Sub.txt",
            provenance = PublicSourceProvenance("aggregator", "barry-far", "https://github.com/barry-far/V2ray-Config",
                "MIT", "https://github.com/barry-far/V2ray-Config/blob/main/LICENSE")),
        PublicCatalogSource("mahdibland-public", "V2RayAggregator public", PublicSourceFormat.URI_OR_BASE64,
            "https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/Eternity.txt",
            provenance = PublicSourceProvenance("aggregator", "mahdibland", "https://github.com/mahdibland/V2RayAggregator",
                "GPL-3.0", "https://github.com/mahdibland/V2RayAggregator/blob/master/LICENSE"),
            // GitHub's contents API identifies this exact canonical download URL after the repository rename.
            // This is a same-host redirect alias, not an independent recovery source.
            redirectTargets = listOf("https://raw.githubusercontent.com/mahdibland/V2RayAggregator/master/Eternity.txt")),
        igareck("igareck-vless", "Russia checked · VLESS", "BLACK_VLESS_RUS.txt"),
        igareck("igareck-mixed", "Russia checked · mixed", "BLACK_SS%2BAll_RUS.txt"),
        PublicCatalogSource("vpngate", "VPN Gate", PublicSourceFormat.VPN_GATE_CSV,
            "https://www.vpngate.net/api/iphone/", provenance = PublicSourceProvenance("volunteer", "VPN Gate",
                "https://www.vpngate.net/en/", "VPN Gate public service policy", "https://www.vpngate.net/en/about_abuse.aspx")),
    )

    private fun igareck(id: String, name: String, file: String) = PublicCatalogSource(id, name, PublicSourceFormat.URI_OR_BASE64,
        "https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/$file",
        listOf("https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/$file",
            "https://codeberg.org/igareck/vpn-configs-for-russia/raw/branch/main/$file",
            "https://gitea.com/igareck/vpn-configs-for-russia/raw/branch/main/$file"), igareckProvenance)

    /** Only complete share links and VPN Gate's public CSV are imported; no remote runtime config is activated. */
    fun parse(source: PublicCatalogSource, raw: String, checkActive: () -> Unit = {}): List<TunnelProfile> {
        checkActive()
        require(raw.toByteArray(Charsets.UTF_8).size <= MAX_SOURCE_BYTES) { localized("PublicCatalog.4ae1758e2595", "Публичный список слишком большой") }
        var body = raw.trim().removePrefix("\uFEFF")
        require(body.isNotEmpty()) { localized("PublicCatalog.6376714e8ea1", "Пустой публичный список") }
        if (source.format == PublicSourceFormat.URI_OR_BASE64 && !body.contains("://")) {
            val encoded = body.filterNot(Char::isWhitespace).replace('-', '+').replace('_', '/')
            body = runCatching { Base64.getDecoder().decode(encoded).toString(Charsets.UTF_8) }.getOrDefault(body)
        }
        val head = body.trimStart()
        require(!head.startsWith('<') && !head.startsWith('{') && !head.startsWith('[') &&
            !Regex("^\\s*(?:proxies|outbounds|inbounds|proxy-groups|rules|dns)\\s*:", RegexOption.MULTILINE).containsMatchIn(body)) {
            localized("PublicCatalog.549dd2169a1b", "Источник должен содержать ссылки или публичный CSV, а не конфигурацию приложения")
        }
        val parsed = when (source.format) {
            PublicSourceFormat.VPN_GATE_CSV -> {
                require(body.startsWith("*vpn_servers") || body.startsWith("#HostName,IP,")) { localized("PublicCatalog.3ce07e770b2b", "Неизвестный формат VPN Gate") }
                body.lineSequence().filter { it.isNotBlank() && !it.startsWith('#') && !it.startsWith('*') }
                    .take(1_000).mapNotNull { row -> checkActive(); runCatching {
                        val cols = row.split(','); require(cols.size >= 15)
                        OpenVpnImporter.parse(ProfileImporter.base64(cols[14]).toString(Charsets.UTF_8), cols[0]).copy(country = cols[6])
                    }.getOrNull() }.toList()
            }
            PublicSourceFormat.URI_OR_BASE64 -> body.lineSequence().map(String::trim).filter(links::matches)
                .take(5_000).mapNotNull { line -> checkActive(); runCatching { ProfileImporter.link(line) }.getOrNull() }.toList()
        }
        val profiles = parsed.asSequence().filter(PublicSourcePolicy::publicProfile)
            .distinctBy(ProfileImporter::identity).take(SOURCE_NODE_LIMIT).map { profile ->
                profile.copy(id = "pub-${ProfileImporter.identity(profile).take(24)}", source = "public")
            }.toList()
        require(profiles.isNotEmpty()) { localized("PublicCatalog.a5f0a9fd23ce", "Источник не содержит поддерживаемых публичных узлов") }
        return profiles
    }

    /** A mirror succeeds only after its bounded body parses, not just because it returned HTTP 200. */
    suspend fun loadSource(source: PublicCatalogSource, fetcher: suspend (PublicCatalogSource, String, Int) -> String): List<TunnelProfile> =
        NetworkOperation.within(SOURCE_TIMEOUT_MS) {
            var accepted: List<TunnelProfile>? = null
            for (url in source.endpoints) {
                coroutineContext.ensureActive()
                try {
                    val raw = NetworkOperation.within(ATTEMPT_TIMEOUT_MS) { fetcher(source, url, MAX_SOURCE_BYTES) }
                    val parsed = withContext(Dispatchers.Default) {
                        val context = coroutineContext
                        parse(source, raw) { context.ensureActive() }
                    }
                    coroutineContext.ensureActive()
                    accepted = parsed
                    break
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* Only the next publisher-documented delivery endpoint may be tried. */ }
            }
            accepted ?: error(localized("PublicCatalog.a25a0674889e", "Источник недоступен или формат не поддерживается"))
        }

    /** A large first feed must not consume the entire pool before smaller publications get a turn. */
    fun fairPool(sources: List<List<TunnelProfile>>, limit: Int = MAX_PROFILES): List<TunnelProfile> {
        val out = LinkedHashMap<String, TunnelProfile>()
        val iterators = sources.map { it.iterator() }
        while (out.size < limit && iterators.any { it.hasNext() }) {
            for (iterator in iterators) {
                if (iterator.hasNext()) iterator.next().let { out.putIfAbsent(ProfileImporter.identity(it), it) }
                if (out.size >= limit) break
            }
        }
        return out.values.toList()
    }

    /** Cache age is not credential expiry. Keep old candidates across feed outages within the same bounded store. */
    fun merge(existing: List<TunnelProfile>, incoming: List<TunnelProfile>, preferredIds: Set<String> = emptySet(),
        blockedIdentities: Set<String> = emptySet(), limit: Int = MAX_PROFILES): List<TunnelProfile> {
        require(limit in 1..MAX_PROFILES)
        val blocked = blockedIdentities + existing.filter { it.revoked || it.subscriptionMissing }
            .mapNotNull { runCatching { ProfileImporter.identity(it) }.getOrNull() }
        fun eligible(profile: TunnelProfile) = profile.source == "public" && !profile.revoked && !profile.subscriptionMissing &&
            PublicSourcePolicy.publicProfile(profile) && ProfileImporter.identity(profile) !in blocked
        val old = existing.filter(::eligible).associateBy(ProfileImporter::identity)
        val fresh = incoming.filter(::eligible).map { next ->
            old[ProfileImporter.identity(next)]?.let { next.copy(id = it.id, addedAt = it.addedAt) } ?: next
        }
        val preferred = old.values.filter { it.id in preferredIds }.take(minOf(128, limit / 4))
        return (preferred + fairPool(listOf(fresh, old.values.toList()), limit)).distinctBy(ProfileImporter::identity).take(limit)
    }

    /** Health belongs to one observed physical network and expires; an old candidate remains selectable for a new test. */
    fun freshHealth(observations: Map<String, ProbeHealth>, observedNetwork: Long?, currentNetwork: Long?, now: Long): Map<String, ProbeHealth> {
        if (observedNetwork == null || currentNetwork == null || observedNetwork != currentNetwork) return emptyMap()
        val current = observations.filterValues { it.checkedAt > 0 && now >= it.checkedAt && now - it.checkedAt <= HEALTH_TTL_MS }
        return if (current.size == observations.size) observations else current
    }

    /** Prefer different hosts/subnets/protocols/countries; these hints do not assert provider/ASN independence. */
    fun diverseBest(profiles: List<TunnelProfile>, delays: Map<String, Long>, limit: Int = 5): List<TunnelProfile> {
        val remaining = profiles.filter { delays[it.id]?.let { delay -> delay >= 0 } == true && !it.revoked && !it.subscriptionMissing }
            .distinctBy(ProfileImporter::identity).toMutableList()
        val selected = mutableListOf<TunnelProfile>()
        while (selected.size < limit && remaining.isNotEmpty()) {
            val best = if (selected.isEmpty()) remaining.minByOrNull { delays.getValue(it.id) }!!
            else remaining.minWithOrNull(compareBy<TunnelProfile>(
                { candidate -> selected.count { it.host.equals(candidate.host, true) } },
                { candidate -> selected.count { networkHint(it.host) == networkHint(candidate.host) } },
                { candidate -> selected.count { it.protocol == candidate.protocol } },
                { candidate -> if (candidate.country.isBlank()) 1 else selected.count { it.country == candidate.country } },
                { delays.getValue(it.id) }))!!
            selected.add(best)
            // Alternate credentials/ports on the same server do not make a useful five-server reserve.
            remaining.removeAll { it.host.equals(best.host, true) }
        }
        return selected
    }

    private fun networkHint(host: String): String {
        val value = host.removeSurrounding("[", "]").lowercase()
        if (!AddressRules.isIp(value)) return value
        val bytes = InetAddress.getByName(value).address
        return bytes.take(if (bytes.size == 4) 3 else 6).joinToString(":") { (it.toInt() and 255).toString() }
    }
}
