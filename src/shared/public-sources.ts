/** Public catalog inputs, not a list of trusted or currently reachable relays.
 * Repository licences describe the publication; they do not establish who owns
 * every aggregated relay. Keep that distinction in docs/SOURCES.md and the UI. */
export type PublicSourceFormat = 'uri-or-base64' | 'vpngate-csv'

export interface PublicCatalogSource {
  readonly id: string
  readonly name: string
  readonly format: PublicSourceFormat
  readonly url: string
  readonly mirrors: readonly string[]
  readonly provenance: {
    readonly kind: 'aggregator' | 'volunteer'
    readonly publisher: string
    readonly homepage: string
    readonly license: string
    readonly licenseUrl: string
    readonly reviewedAt: string
    readonly mirrorDocumentation?: string
  }
}

const igareckProvenance: PublicCatalogSource['provenance'] = {
  kind: 'aggregator', publisher: 'igareck',
  homepage: 'https://github.com/igareck/vpn-configs-for-russia',
  license: 'GPL-3.0', licenseUrl: 'https://github.com/igareck/vpn-configs-for-russia/blob/main/LICENSE',
  reviewedAt: '2026-11-18',
  mirrorDocumentation: 'https://github.com/igareck/vpn-configs-for-russia/blob/main/MIRRORS.md'
}

/** Mirrors are explicit publisher-documented endpoints. They are fallback
 * delivery paths for the same source, never additional independent sources. */
export const PUBLIC_SOURCES: readonly PublicCatalogSource[] = [
  {
    id: 'awesome-vpn', name: 'Awesome VPN', format: 'uri-or-base64',
    url: 'https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all', mirrors: [],
    provenance: {
      kind: 'aggregator', publisher: 'awesome-vpn', homepage: 'https://github.com/awesome-vpn/awesome-vpn',
      license: 'GPL-3.0', licenseUrl: 'https://github.com/awesome-vpn/awesome-vpn/blob/master/LICENSE', reviewedAt: '2026-11-18'
    }
  },
  {
    id: 'mrdevmohamed', name: 'V2Ray Configs', format: 'uri-or-base64',
    url: 'https://raw.githubusercontent.com/mrdevmohamed/v2ray-configs/main/All_Configs_Sub.txt', mirrors: [],
    provenance: {
      kind: 'aggregator', publisher: 'mrdevmohamed', homepage: 'https://github.com/mrdevmohamed/v2ray-configs',
      license: 'GPL-3.0', licenseUrl: 'https://github.com/mrdevmohamed/v2ray-configs/blob/main/LICENSE', reviewedAt: '2026-11-18'
    }
  },
  {
    id: 'barry', name: 'Barry V2Ray Config', format: 'uri-or-base64',
    url: 'https://raw.githubusercontent.com/barry-far/V2ray-config/main/All_Configs_Sub.txt', mirrors: [],
    provenance: {
      kind: 'aggregator', publisher: 'barry-far', homepage: 'https://github.com/barry-far/V2ray-Config',
      license: 'MIT', licenseUrl: 'https://github.com/barry-far/V2ray-Config/blob/main/LICENSE', reviewedAt: '2026-11-18'
    }
  },
  {
    id: 'mahdibland-public', name: 'V2RayAggregator public', format: 'uri-or-base64',
    // The publisher's README still documents the previous repository name.
    // EternityAir (trial/airport offers) is deliberately outside this registry.
    url: 'https://raw.githubusercontent.com/mahdibland/ShadowsocksAggregator/master/Eternity.txt', mirrors: [],
    provenance: {
      kind: 'aggregator', publisher: 'mahdibland', homepage: 'https://github.com/mahdibland/V2RayAggregator',
      license: 'GPL-3.0', licenseUrl: 'https://github.com/mahdibland/V2RayAggregator/blob/master/LICENSE', reviewedAt: '2026-11-18'
    }
  },
  {
    id: 'igareck-vless', name: 'Russia checked · VLESS', format: 'uri-or-base64',
    url: 'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS.txt',
    mirrors: [
      'https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/BLACK_VLESS_RUS.txt',
      'https://codeberg.org/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_VLESS_RUS.txt',
      'https://gitea.com/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_VLESS_RUS.txt'
    ],
    provenance: igareckProvenance
  },
  {
    id: 'igareck-mixed', name: 'Russia checked · mixed', format: 'uri-or-base64',
    url: 'https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_SS%2BAll_RUS.txt',
    mirrors: [
      'https://gitlab.com/igareck/vpn-configs-for-russia/-/raw/main/BLACK_SS%2BAll_RUS.txt',
      'https://codeberg.org/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_SS%2BAll_RUS.txt',
      'https://gitea.com/igareck/vpn-configs-for-russia/raw/branch/main/BLACK_SS%2BAll_RUS.txt'
    ],
    provenance: igareckProvenance
  },
  {
    id: 'vpngate', name: 'VPN Gate', format: 'vpngate-csv',
    url: 'https://www.vpngate.net/api/iphone/', mirrors: [],
    provenance: {
      kind: 'volunteer', publisher: 'VPN Gate', homepage: 'https://www.vpngate.net/en/',
      license: 'VPN Gate public service policy', licenseUrl: 'https://www.vpngate.net/en/about_abuse.aspx', reviewedAt: '2026-11-18'
    }
  }
]

/** Kept as string[] for the catalog and existing IPC/settings callers. */
export const DEFAULT_SOURCES: string[] = PUBLIC_SOURCES.map(source => source.url)

export function publicSourceForUrl(url: string): PublicCatalogSource | undefined {
  return PUBLIC_SOURCES.find(source => source.url === url || source.mirrors.includes(url))
}
