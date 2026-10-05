import type { Api } from '../../preload'
import type { AppInfo, Conn, ProfileView, Settings, Snapshot, Status } from '../../shared/types'
import { effectiveRoutes } from '../../shared/effective'
import { classify } from '../../shared/evidence'

function mock(): Api {
  const subs: Record<string, ((v: any) => void)[]> = {}
  const emit = (ch: string, v: unknown) => (subs[ch] ?? []).forEach(f => f(ch === 'status' ? { ...(v as Status), routes: effectiveRoutes(settings, profiles, v as Status) } : v))
  const on = (ch: string) => (cb: (v: any) => void) => { (subs[ch] ??= []).push(cb); return () => { subs[ch] = subs[ch].filter(f => f !== cb) } }
  const empty = location.hash === '#empty'
  const fbDemo = location.hash.includes('fallback')
  let settings: Settings = { rest: 'direct', groups: [], ruDirect: true, dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: true, routes: [
    { id: 'app:d', kind: 'app', name: 'Discord', exe: 'C:\\Program Files\\Discord\Discord.exe', matchDir: 'C:\\Program Files\\Discord', via: 'a', ...(fbDemo ? { fallback: 'b' } : {}), on: true },
    { id: 'app:Telegram', kind: 'app', name: 'Telegram', exe: 'C:\\Program Files\\Telegram\Telegram.exe', matchDir: 'C:\\Program Files\\Telegram', via: 'b', on: true },
    { id: 'app:Claude', kind: 'app', name: 'Claude', exe: 'C:\\Program Files\\Claude\Claude.exe', matchDir: 'C:\\Program Files\\Claude', via: 'a', on: true },
    { id: 'app:Dota 2', kind: 'app', name: 'Dota 2', exe: 'C:\\Games\\Dota 2\\dota2.exe', matchDir: 'C:\\Games\\Dota 2', via: 'direct', on: false },
    { id: 'preset:youtube', kind: 'preset', name: 'YouTube', preset: 'youtube', via: 'a', on: true },
    { id: 'custom:rutracker.org', kind: 'custom', name: 'rutracker.org', value: 'rutracker.org', via: 'b', on: true },
    // review volume (#many): ~10 mixed targets
    ...(location.hash.includes('many') ? [
      { id: 'app:Steam', kind: 'app', name: 'Steam', exe: 'C:\Program Files\Steam\steam.exe', matchDir: 'C:\Program Files\Steam', via: 'direct', on: true },
      { id: 'preset:chatgpt', kind: 'preset', name: 'ChatGPT', preset: 'chatgpt', via: 'a', on: true },
      { id: 'preset:instagram', kind: 'preset', name: 'Instagram', preset: 'instagram', via: 'b', on: true },
      { id: 'custom:db.team.local', kind: 'custom', name: 'db.team.local', value: 'db.team.local', via: 'direct', on: true },
      ...(location.hash.includes('broken') ? [{ id: 'app:Old', kind: 'app', name: 'Старый клиент', exe: 'C:\Old\old.exe', matchDir: 'C:\Old', via: 'gone-1', on: true }] : []),
    ] as Settings['routes'] : [])
  ] }
  let status: Status = { phase: 'off', pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 }
  let profiles: ProfileView[] = empty ? [] : [{ kind: 'awg', id: 'a', name: 'Сервер 1', host: '203.0.113.10', port: 51820, address: ['10.8.0.7/32'], version: 'AmneziaWG 2' }, { kind: 'vless', id: 'b', name: 'Запасной', host: '198.51.100.3', port: 443, address: [], version: 'VLESS · REALITY · XHTTP', subscription: true }]
  const snap = (): Snapshot => ({
    admin: true,
    profiles,
    settings, status,
    notices: [{ level: 'info', title: 'Рядом работает Radmin VPN', text: 'Он не забирает весь трафик, конфликта нет.' }]
  })
  const apps: AppInfo[] = ['Discord', 'Telegram', 'Google Chrome', 'Firefox', 'Steam', 'Visual Studio Code', 'Spotify', 'Claude', 'Obsidian', 'qBittorrent', 'Dota 2', 'Cursor'].map((n, i) => ({
    id: i === 0 ? 'd' : n, name: n, exe: `C:\\Program Files\\${n}\\${n}.exe`, matchDir: `C:\\Program Files\\${n}`, running: i % 3 !== 2, windowed: i % 2 === 0, source: 'installed'
  }))
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    snapshot: async () => snap(),
    toggle: async () => {
      if (status.phase === 'on') { clearInterval(timer); status = { phase: 'off', pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 }; emit('status', status); emit('conns', []); return { ok: true } }
      status = { ...status, phase: 'starting' }; emit('status', status)
      await new Promise(r => setTimeout(r, 1400))
      status = { ...status, phase: 'on', since: Date.now(), pings: { a: fbDemo ? undefined : 48, b: 112, 'g-auto': fbDemo ? 112 : 48, direct: 9 }, picked: { 'g-auto': fbDemo ? 'b' : 'a' }, fallback: fbDemo ? { 'app:d': 'b' } : {} }; emit('status', status)
      timer = setInterval(() => {
        const d = 40000 + Math.random() * 900000, u = 5000 + Math.random() * 90000
        const pa = fbDemo ? undefined : 40 + Math.round(Math.random() * 20), pb = 100 + Math.round(Math.random() * 40)
        status = { ...status, pings: { a: pa, b: pb, 'g-auto': fbDemo ? pb : pa, direct: 8 + Math.round(Math.random() * 4) }, down: d, up: u, downTotal: status.downTotal + d, upTotal: status.upTotal + u }
        emit('status', status)
        const conns: Conn[] = [['Discord', 'gateway.discord.gg', true], ['chrome', 'rr3---sn-4g5e.googlevideo.com', true], ['chrome', 'yandex.ru', false], ['Steam', 'steamcdn-a.akamaihd.net', false], ['Claude', 'claude.ai', true]].map(([a, h, v], i) => ({
          id: String(i), app: a as string, exe: i === 0 ? apps[0].exe : '', host: h as string, port: 443, net: 'tcp', via: v ? (i === 1 ? 'b' : 'a') : 'direct', rule: '', down: Math.random() * 9e6, up: Math.random() * 4e5, start: Date.now() - i * 61000
        }))
        emit('conns', conns)
      }, 1000)
      return { ok: true }
    },
    scanApps: async () => { await new Promise(r => setTimeout(r, 600)); return apps },
    pickApp: async () => null,
    settings: async (p: Partial<Settings>) => { settings = { ...settings, ...p }; return snap() },
    selectRoute: async (routeId: string, via: string) => { settings = { ...settings, routes: settings.routes.map(r => r.id === routeId ? { ...r, via, on: true, fallback: undefined } : r) }; emit('snapshot', snap()); return { ok: true, saved: true, applied: status.phase === 'on' } },
    validate: async (v: string) => (/^[\w.-]+\.[a-z]{2,}$|^\d+\.\d+\.\d+\.\d+(\/\d+)?$/i.test(v) ? null : 'Нужен домен или IP'),
    importProfile: async () => ({ ok: false, error: 'Это превью, импорт работает только в приложении' }),
    createWireGuard: async (fields: { name: string; address: string; endpoint: string; serverPublicKey: string }) => {
      const clientPublicKey = 'q9MMmIcttvDr6uEcmpRFioaJZ5sHOAannstz3+5cwBM='
      const [host, port] = fields.endpoint.split(':')
      profiles = [...profiles, { kind: 'awg', id: 'mock-created', name: fields.name, host, port: Number(port), address: [fields.address], version: 'WireGuard', clientPublicKey, source: 'personal' }]
      emit('snapshot', snap())
      return { ok: true, added: 1, name: fields.name, clientPublicKey }
    },
    clipPeek: async () => ({ kind: 'none' }),
    scanQr: async () => ({ ok: false, error: 'В браузерном превью снимок экрана недоступен' }),
    discoverScan: async () => ({ ok: true, items: [] }),
    discoverPickFolder: async () => ({ ok: false, canceled: true }),
    discoverAdd: async () => ({ ok: false, error: 'Это превью, добавление работает только в приложении' }),
    renameProfile: async () => undefined,
    replaceProfile: async () => ({ ok: false, error: 'Это превью, обновление работает только в приложении' }),
    refreshSubscription: async () => ({ ok: true, updated: 2, added: 1, missing: 0 }),
    removeProfile: async () => undefined,
    notices: async () => [],
    probe: async (t: string) => ({ direct: t.includes('youtube') ? null : 31, a: 88, b: 140 }),
    diagnose: async (t: string) => {
      await new Promise(r => setTimeout(r, 500))
      const cut = t.includes('youtube'), dns = t.includes('rutracker'), dead = t.includes('dead')
      const ok = { result: 'ok' as const }, skip = { result: 'skipped' as const }
      const direct = dead ? { dnsSystem: { result: 'fail' as const, code: 'nxdomain' as const }, dnsDoh: { result: 'fail' as const, code: 'nxdomain' as const }, tcp: skip, tls: skip, http: skip }
        : dns ? { dnsSystem: { result: 'fail' as const, code: 'empty' as const }, dnsDoh: { ...ok, addrs: 2 }, tcp: ok, tls: ok, http: { result: 'ok' as const, status: 200 } }
        : cut ? { dnsSystem: { ...ok, addrs: 4 }, dnsDoh: { ...ok, addrs: 4 }, tcp: ok, tls: { result: 'fail' as const, code: 'reset' as const }, http: skip }
        : { dnsSystem: { ...ok, addrs: 2 }, dnsDoh: { ...ok, addrs: 2 }, tcp: ok, tls: ok, http: { result: 'ok' as const, status: 200 } }
      const paths = dead ? { a: null, b: null } : { a: 88, b: 140 }
      return { target: t, direct, paths, finding: classify(direct, paths) }
    },
    resetNet: async () => ({ ok: true }),
    log: async () => ['+0000 INFO router: updated', '+0000 INFO inbound/tun[tun]: started at Waarp'],
    relaunchAdmin: async () => undefined,
    win: () => undefined,
    onSnapshot: on('snapshot'),
    onStatus: on('status'),
    onConns: on('conns'),
    onToast: on('toast'),
    onNav: on('nav'),
    companionChoose: async (id: string, via: string) => { settings = { ...settings, routes: [...settings.routes.filter(r => r.id !== id), { id, kind: 'custom', name: id, value: 'example.com', via, on: true, owner: 'companion' }] }; emit('snapshot', snap()); return { ok: true, id } },
    catalogGet: async () => ({ updatedAt: Date.now() - 6e5, busy: false, total: 1840, checked: 160, sources: [{ url: 'igareck', ok: true, count: 1500 }, { url: 'awesome-vpn', ok: true, count: 340 }],
      alive: [['🇩🇪 Frankfurt', 'VLESS · REALITY', 48, 'DE', 'Russia checked'], ['🇳🇱 Amsterdam', 'Trojan · TLS', 61, 'NL', 'Epodonios'], ['🇫🇮 Helsinki', 'Shadowsocks · aes-256-gcm', 72, 'FI', 'Awesome VPN'], ['🇺🇸 New York', 'VMess · TLS · WS', 131, 'US', 'VPN Gate'], ['🇯🇵 Tokyo', 'Hysteria2', 212, 'JP', 'V2Ray Configs']].map(([n, p, ms, c, source], i) => ({ id: 'pub' + i, name: n, proto: p, host: '198.51.100.' + (i + 1), port: 443, country: c, source, ping: ms, alive: true })) }),
    catalogRefresh: async () => undefined,
    catalogAdd: async (id: string) => ({ ok: true, id }),
    catalogBest: async () => ({ ok: true, id: 'g-public' }),
    onCatalog: on('catalog')
  } as unknown as Api
}

export const api: Api = (window as any).api ?? mock()
