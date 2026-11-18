import type { DiagnosticProxy } from './diagnostic-proxy'

/** Empty slots are inert authenticated loopback destinations, never public nodes. */
export interface RelaySlot extends DiagnosticProxy { id: string }
export interface RelayGraph { slots: readonly RelaySlot[]; bindings: Readonly<Record<string, string>> }
export interface ForwardProxy { proxy: DiagnosticProxy; profileId: string }
export const RELAY_DNS_IP = '127.0.0.53'
export const relayDnsTag = (slot: string) => 'dns-' + slot
export const relayOutbounds = (slots: readonly RelaySlot[]) => slots.map(slot => ({
  type: 'socks', tag: slot.id, server: '127.0.0.1', server_port: slot.port, version: '5',
  username: slot.username, password: slot.password,
  // Both ends are our pinned sing-box process. Keep local datagrams inside the
  // authenticated stream; the selected server's actual protocol stays unchanged.
  udp_over_tcp: { enabled: true, version: 2 }
}))
