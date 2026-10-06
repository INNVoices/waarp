import { contextBridge, ipcRenderer } from 'electron'

const on = (ch: string) => (cb: (v: any) => void) => {
  const h = (_e: unknown, v: unknown) => cb(v)
  ipcRenderer.on(ch, h)
  return () => { ipcRenderer.removeListener(ch, h) }
}

const api = {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  toggle: () => ipcRenderer.invoke('toggle'),
  scanApps: () => ipcRenderer.invoke('apps:scan'),
  pickApp: () => ipcRenderer.invoke('apps:pick'),
  settings: (patch: unknown) => ipcRenderer.invoke('settings', patch),
  selectRoute: (routeId: string, via: string) => ipcRenderer.invoke('route:select', routeId, via),
  validate: (v: string) => ipcRenderer.invoke('custom:validate', v),
  importProfile: (from: unknown) => ipcRenderer.invoke('profile:import', from),
  createWireGuard: (fields: { name: string; address: string; endpoint: string; serverPublicKey: string }) => ipcRenderer.invoke('profile:create-wg', fields),
  clipPeek: () => ipcRenderer.invoke('clip:peek'),
  scanQr: () => ipcRenderer.invoke('qr:scan'),
  discoverScan: () => ipcRenderer.invoke('discover:scan'),
  discoverPickFolder: () => ipcRenderer.invoke('discover:pick-folder'),
  discoverAdd: (ids: string[]) => ipcRenderer.invoke('discover:add', ids),
  renameProfile: (id: string, name: string) => ipcRenderer.invoke('profile:rename', id, name),
  replaceProfile: (id: string, from: { file?: boolean; text?: string }) => ipcRenderer.invoke('profile:replace', id, from),
  refreshSubscription: (id: string) => ipcRenderer.invoke('profile:refresh-sub', id),
  removeProfile: (id: string, replace?: string) => ipcRenderer.invoke('profile:remove', id, replace),
  notices: () => ipcRenderer.invoke('notices'),
  probe: (t: string) => ipcRenderer.invoke('probe', t),
  diagnose: (t: string) => ipcRenderer.invoke('diagnose', t),
  log: () => ipcRenderer.invoke('log'),
  resetNet: () => ipcRenderer.invoke('net:reset'),
  relaunchAdmin: () => ipcRenderer.invoke('admin:relaunch'),
  win: (a: 'min' | 'max' | 'close') => ipcRenderer.send('win', a),
  onSnapshot: on('snapshot'),
  onStatus: on('status'),
  onConns: on('conns'),
  onApps: on('apps'),
  onToast: on('toast'),
  /** main asks the window to show a route / the companion path picker (bridge routes.open) */
  onNav: on('nav'),
  companionChoose: (id: string, via: string) => ipcRenderer.invoke('companion:choose', id, via),
  // WRP-015 public catalog
  catalogGet: () => ipcRenderer.invoke('catalog:get'),
  catalogRefresh: () => ipcRenderer.invoke('catalog:refresh'),
  catalogAdd: (id: string) => ipcRenderer.invoke('catalog:add', id),
  catalogBest: () => ipcRenderer.invoke('catalog:best'),
  onCatalog: on('catalog')
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
