import type { Api } from '../../preload'
import type { AppInfo, Conn, ProfileView, Settings, Snapshot, Status } from '../../shared/types'
import { effectiveRoutes } from '../../shared/effective'
import { classify } from '../../shared/evidence'
import { assessConnection, connectionUse, summarizeChecks } from '../../shared/connection-quality'
import { atlasCountry, projectAtlas } from '../../shared/atlas'

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
  let toggleVersion = 0
  const disconnect = async () => {
    toggleVersion++
    clearInterval(timer)
    status = { phase: 'off', open: false, pings: {}, fallback: {}, down: 0, up: 0, downTotal: 0, upTotal: 0 }
    emit('status', status); emit('conns', [])
    return { ok: true }
  }
  // Browser-only server examples; the production renderer always uses preload IPC.
  const publicExamples = [
    ['Frankfurt', 'VLESS · REALITY', 'DE', 'Russia checked'],
    ['Amsterdam', 'Trojan · TLS', 'NL', 'Epodonios'],
    ['Helsinki', 'Shadowsocks', 'FI', 'Awesome VPN'],
    ['New York', 'VMess · TLS · WS', 'US', 'VPN Gate'],
    ['Tokyo', 'Hysteria2', 'JP', 'V2Ray Configs']
  ]
  const publicNodes = Array.from({ length: 72 }, (_, index) => {
    const [name, proto, country, source] = publicExamples[index % publicExamples.length]
    return { id: 'pub' + index, name: `${name}${index < 5 ? '' : ' ' + (index + 1)}`, proto, country, source,
      host: '198.51.100.' + (index + 1), port: 443, ping: index < 5 ? 48 + index * 31 : undefined,
      checkedAt: index < 5 ? Date.now() : undefined, status: (index < 5 ? 'ready' : 'unverified') as 'ready' | 'unverified' }
  })
  const publicRegion = (country: string) => ['DE', 'NL', 'FI'].includes(country) ? 'eu' : country === 'US' ? 'americas' : 'asia'
  const catalogState = () => ({ updatedAt: Date.now() - 6e5, busy: false, total: publicNodes.length, cachedCount: publicNodes.length,
    readyCount: publicNodes.filter(node => node.status === 'ready').length, checked: 5,
    sources: [{ url: 'igareck', ok: true, count: publicNodes.length }],
    alive: publicNodes.filter(node => node.status === 'ready'), cached: publicNodes })
  return {
    snapshot: async () => snap(),
    toggle: async () => {
      if (status.open || status.phase === 'on' || status.phase === 'starting') return disconnect()
      const version = ++toggleVersion
      status = { ...status, phase: 'starting', open: true }; emit('status', status)
      await new Promise(r => setTimeout(r, 1400))
      if (version !== toggleVersion) return { ok: false }
      status = { ...status, phase: 'on', since: Date.now(), pings: { a: fbDemo ? undefined : 48, b: 112, 'g-auto': fbDemo ? 112 : 48, direct: 9 }, pingRound: (status.pingRound ?? 0) + 1, picked: { 'g-auto': fbDemo ? 'b' : 'a' }, fallback: fbDemo ? { 'app:d': 'b' } : {} }; emit('status', status)
      timer = setInterval(() => {
        const d = 40000 + Math.random() * 900000, u = 5000 + Math.random() * 90000
        const pa = fbDemo ? undefined : 40 + Math.round(Math.random() * 20), pb = 100 + Math.round(Math.random() * 40)
        status = { ...status, pings: { a: pa, b: pb, 'g-auto': fbDemo ? pb : pa, direct: 8 + Math.round(Math.random() * 4) }, pingRound: (status.pingRound ?? 0) + 1, down: d, up: u, downTotal: status.downTotal + d, upTotal: status.upTotal + u }
        emit('status', status)
        const conns: Conn[] = [['Discord', 'gateway.discord.gg', true], ['chrome', 'rr3---sn-4g5e.googlevideo.com', true], ['chrome', 'yandex.ru', false], ['Steam', 'steamcdn-a.akamaihd.net', false], ['Claude', 'claude.ai', true]].map(([a, h, v], i) => ({
          id: String(i), app: a as string, exe: i === 0 ? apps[0].exe : '', host: h as string, port: 443, net: 'tcp', via: v ? (i === 1 ? 'b' : 'a') : 'direct', rule: '', down: Math.random() * 9e6, up: Math.random() * 4e5, start: Date.now() - i * 61000
        }))
        emit('conns', conns)
      }, 1000)
      return { ok: true }
    },
    disconnect,
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
    diagnose: async (t: string, routeId?: string) => {
      await new Promise(r => setTimeout(r, 500))
      const cut = t.includes('youtube'), dns = t.includes('rutracker'), dead = t.includes('dead')
      const ok = { result: 'ok' as const }, skip = { result: 'skipped' as const }
      const direct = dead ? { dnsSystem: { result: 'fail' as const, code: 'nxdomain' as const }, dnsDoh: { result: 'fail' as const, code: 'nxdomain' as const }, tcp: skip, tls: skip, http: skip }
        : dns ? { dnsSystem: { result: 'fail' as const, code: 'empty' as const }, dnsDoh: { ...ok, addrs: 2 }, tcp: ok, tls: ok, http: { result: 'ok' as const, status: 200 } }
        : cut ? { dnsSystem: { ...ok, addrs: 4 }, dnsDoh: { ...ok, addrs: 4 }, tcp: ok, tls: { result: 'fail' as const, code: 'reset' as const }, http: skip }
        : { dnsSystem: { ...ok, addrs: 2 }, dnsDoh: { ...ok, addrs: 2 }, tcp: ok, tls: ok, http: { result: 'ok' as const, status: 200 } }
      const paths = dead ? { a: null, b: null } : { a: 88, b: 140 }
      const route = settings.routes.find(r => r.id === routeId)
      const samples = summarizeChecks([paths, paths])
      const scope = route ? { routeId: route.id, routeName: route.name, connectionUse: connectionUse(route.connectionUse), selectedVia: route.via, effectiveVia: route.via } : undefined
      return { target: t, host: t.replace(/^https?:\/\//, '').replace(/[/?#:].*$/, '').toLowerCase(), direct, paths, finding: classify(direct, paths), at: Date.now(), token: 'preview-diagnosis', samples, scope,
        assessment: scope ? assessConnection(scope.connectionUse, scope.effectiveVia, samples, ['a', 'b']) : undefined, systemPath: true }
    },
    diagnoseCancel: async () => true,
    payloadLast: async () => undefined,
    payloadRun: async () => ({ error: 'engine' }),
    payloadCancel: async () => true,
    diagnoseApply: async (_token: string, _via: string) => ({ ok: false, error: 'stale' }) as { ok: boolean; error?: string; id?: string },
    resetNet: async () => ({ ok: true }),
    log: async () => ['+0000 INFO router: updated', '+0000 INFO inbound/tun[tun]: started at Waarp'],
    profileConfig: async (id: string) => ({ type: 'vless', tag: 'p-' + id, server: 'demo.example', server_port: 443, uuid: '•••' }) as unknown,
    exportDiag: async () => ({ ok: true }) as { ok: boolean; error?: boolean },
    diagnosticHistory: async () => ({ schema: 1, available: true, events: [] }),
    clearDiagnosticHistory: async () => ({ ok: true }),
    tuneRun: async (_id: string) => ({ results: [{ label: '', ms: null }, { label: 'fp firefox', ms: 180 }, { label: 'TLS record fragment', ms: null }], complete: true }) as { results?: { label: string; ms: number | null }[]; complete?: boolean; error?: string },
    tuneCancel: async () => true,
    listAdd: async (_n: string, _u: string) => ({ ok: true }) as { ok: boolean; error?: string; id?: string },
    listRefresh: async (_id: string) => ({ ok: true }) as { ok: boolean },
    listToggle: async (_id: string, _on: boolean) => ({ ok: true }) as { ok: boolean },
    listRemove: async (_id: string) => ({ ok: true }) as { ok: boolean; error?: string },
    tuneApply: async (_id: string, _label: string) => ({ ok: true }) as { ok: boolean; error?: string },
    tuneReset: async (_id: string) => ({ ok: true }) as { ok: boolean },
    relaunchAdmin: async () => undefined,
    win: () => undefined,
    onSnapshot: on('snapshot'),
    onStatus: on('status'),
    onConns: on('conns'),
    onApps: on('apps'),
    onToast: on('toast'),
    onNav: on('nav'),
    companionChoose: async (id: string, via: string) => { settings = { ...settings, routes: [...settings.routes.filter(r => r.id !== id), { id, kind: 'custom', name: id, value: 'example.com', via, on: true, owner: 'companion' }] }; emit('snapshot', snap()); return { ok: true, id } },
    catalogGet: async () => catalogState(),
    catalogPage: async ({ query = '', region, country, page = 1, pageSize = 12, readyOnly = false }: { query?: string; region?: string; country?: string; page?: number; pageSize?: number; readyOnly?: boolean } = {}) => {
      const matched = publicNodes.filter(node => `${node.name} ${node.proto} ${node.host} ${node.country} ${node.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      const mapped = matched.filter(node => (!region || publicRegion(node.country) === region) && (!readyOnly || node.status === 'ready'))
      const items = mapped.filter(node => !country || atlasCountry(node.country) === atlasCountry(country))
      const pages = Math.max(1, Math.ceil(items.length / pageSize)), current = Math.max(1, Math.min(pages, page))
      return { items: items.slice((current - 1) * pageSize, current * pageSize), total: items.length, page: current, pageSize, pages, atlas: projectAtlas(mapped),
        regions: ['eu', 'asia', 'americas', 'other'].map(id => ({ id, name: id, total: matched.filter(node => publicRegion(node.country) === id).length, ready: matched.filter(node => publicRegion(node.country) === id && node.status === 'ready').length })) }
    },
    catalogRefresh: async () => catalogState(),
    catalogVerify: async () => catalogState(),
    catalogAdd: async (id: string) => {
      const node = publicNodes.find(item => item.id === id)
      if (!node) return { ok: false }
      await new Promise(resolve => setTimeout(resolve, 500))
      node.status = 'ready'; node.ping = 61; node.checkedAt = Date.now()
      if (!profiles.some(profile => profile.id === id)) profiles = [...profiles, { id, kind: 'vless', name: node.name, host: node.host, port: node.port, address: [], version: node.proto, source: 'public' }]
      emit('catalog', catalogState()); emit('snapshot', snap())
      return { ok: true, id }
    },
    catalogBest: async () => ({ ok: true, id: 'g-public' }),
    onCatalog: on('catalog')
  } as unknown as Api
}

/** A missing preload is an error, never a pretend working VPN. Fixtures are browser-dev only. */
function unavailable(): Api {
  return new Proxy({} as Api, {
    get: (_target, key) => typeof key === 'string' && key.startsWith('on') ? () => () => {}
      : key === 'win' ? () => {} : () => Promise.reject(new Error('Desktop bridge unavailable'))
  })
}

export const api: Api = (window as any).api ?? (import.meta.env.DEV && !navigator.userAgent.includes('Electron/') ? mock() : unavailable())
