export type AwgParams = Partial<Record<'jc' | 'jmin' | 'jmax' | 's1' | 's2' | 's3' | 's4', number>> &
  Partial<Record<'h1' | 'h2' | 'h3' | 'h4' | 'i1' | 'i2' | 'i3' | 'i4' | 'i5', string>>

import type { VlessProfile } from './vless-types'
export type { VlessProfile, VlessFields } from './vless-types'

export interface AwgProfile {
  kind: 'awg'
  id: string
  name: string
  address: string[]
  privateKey: string
  clientPublicKey?: string
  dns: string[]
  mtu?: number
  awg: AwgParams
  peer: { publicKey: string; presharedKey?: string; host: string; port: number; keepalive?: number }
  version: string
  addedAt: number
  source?: 'personal' | 'managed' | 'warp'
  revoked?: boolean
}

/** any other sing-box outbound from a link (vmess / trojan / ss / hysteria2 / tuic): the outbound JSON is built at import */
export interface OutProfile {
  kind: 'out'
  id: string
  name: string
  /** short protocol label, e.g. "Trojan · TLS" */
  version: string
  host: string
  port: number
  /** sing-box outbound without tag */
  outbound: Record<string, unknown>
  addedAt: number
  /** personal = the user's own; public = public catalog (untrusted); warp = Cloudflare WARP; managed = issued by a team (later) */
  source?: 'personal' | 'public' | 'warp' | 'managed'
  country?: string
  /** revocation: a revoked profile is never activated */
  revoked?: boolean
  /** encrypted at rest; never exposed to renderer, only its presence is shown */
  sub?: string
  /** stable subscription entry identity; keeps a renamed local profile attached across endpoint changes */
  subKey?: string
  subMissing?: boolean
}

export interface OpenVpnProfile {
  kind: 'openvpn'
  id: string
  name: string
  version: string
  host: string
  port: number
  /** sing-box openvpn-client endpoint without tag */
  endpoint: Record<string, unknown>
  addedAt: number
  source?: 'personal' | 'public' | 'managed'
  revoked?: boolean
}

export type Profile = AwgProfile | VlessProfile | OutProfile | OpenVpnProfile

/** a group is a tunnel made of several tunnels: fastest = best ping wins, first = stays on the working one in order */
export type GroupPolicy = 'fastest' | 'first'
export interface Group {
  id: string
  name: string
  policy: GroupPolicy
  members: string[]
}

export interface ProfileView {
  kind: Profile['kind'] | 'group'
  source?: OutProfile['source']
  country?: string
  revoked?: boolean
  subscription?: boolean
  subscriptionMissing?: boolean
  id: string
  name: string
  host: string
  port: number
  address: string[]
  clientPublicKey?: string
  version: string
  members?: string[]
  policy?: GroupPolicy
}

export type Via = 'direct' | string

export interface AppPick {
  id: string
  name: string
  exe: string
  matchDir?: string
}

export type RouteKind = 'app' | 'preset' | 'custom'

export interface Route {
  id: string
  kind: RouteKind
  name: string
  via: Via
  fallback?: Via
  on: boolean
  /** created for a local companion app through the bridge; edited in Waarp like any route */
  owner?: 'companion'
  exe?: string
  matchDir?: string
  wholeDir?: boolean
  preset?: string
  value?: string
  icon?: string
}

export interface AppInfo extends AppPick {
  running: boolean
  windowed: boolean
  icon?: string
  source: 'installed' | 'running' | 'manual'
}

export interface Settings {
  /** global mode: 'direct' = only the cards; a tunnel or group id = everything goes through it (cards set to direct are the exceptions) */
  rest: Via
  /** the last tunnel chosen for "everything through", offered again when the mode is switched back on */
  allVia?: Via
  groups: Group[]
  routes: Route[]
  ruDirect: boolean
  dnsAll: boolean
  /** explicit exemption: private/link-local networks bypass the tunnel so LAN devices remain reachable */
  lanDirect: boolean
  tray: boolean
  autoConnect: boolean
  autostart: boolean
  notify: boolean
}

export type Phase = 'off' | 'starting' | 'on' | 'stopping' | 'error'

export interface Status {
  phase: Phase
  since?: number
  error?: string
  pings: Record<string, number | undefined>
  fallback: Record<string, Via>
  down: number
  up: number
  downTotal: number
  upTotal: number
  /** C08: engine process alive and its controller answers */
  engine?: 'up' | 'down'
  /** C08: per tunnel - ok (a probe answered), degraded (last round failed once), down (2 rounds in a row failed), busy (key live elsewhere, not checked) */
  health?: Record<string, TunnelHealth>
  /** W2.1: effective state per enabled route (+ '*rest' whole-PC exit), computed in main from the plan + evidence */
  routes?: Record<string, import('./effective').RouteEff>
  /** R5: the running core holds `live` of `total` Auto candidates (bounded pool) */
  autoPool?: { live: number; total: number }
  /** R1.4: why a TUN start was refused after a read-only check (Windows was not changed) */
  recovery?: 'tun_stale' | 'tun_collision' | 'tun_unknown'
  /** W2.4: the member each live group (incl. Auto) currently uses, as Waarp selected it */
  picked?: Record<string, string>
}
export type TunnelHealth = 'ok' | 'degraded' | 'down' | 'busy' | 'unknown'

export interface Conn {
  id: string
  app: string
  exe: string
  host: string
  port: number
  net: string
  via: Via
  rule: string
  down: number
  up: number
  start: number
}

export interface Adapter {
  name: string
  desc: string
  ipv4: string[]
  fullRoute: boolean
}

export interface Notice {
  level: 'block' | 'warn' | 'info'
  title: string
  text: string
  action?: 'relaunch-admin'
}

export interface Snapshot {
  admin: boolean
  profiles: ProfileView[]
  settings: Settings
  status: Status
  notices: Notice[]
}
