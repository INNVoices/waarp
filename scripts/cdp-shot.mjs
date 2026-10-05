// Dev check of the REAL app: run `npx electron . --remote-debugging-port=9339 --user-data-dir=%TEMP%/waarp-test` (separate data, no tunnel), then
// node scripts/cdp-shot.mjs <out.jpg> "<js to eval first>" [wait ms]  -> screenshot of the live window. Never start the tunnel in tests.
// tiny CDP driver: node cdp.mjs <out.png> [js-to-eval-before]
import { writeFileSync } from 'node:fs'
const list = await (await fetch('http://127.0.0.1:9339/json')).json()
const t = list.find(x => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const wait = new Map()
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id) } }
const call = (method, params = {}) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise(r => ws.onopen = r)
const js = process.argv[3]
if (js) { const r = await call('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }); console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null).slice(0, 1500)) ; await new Promise(r => setTimeout(r, Number(process.argv[4] ?? 1200))) }
if (process.argv[2] !== '-') { const s = await call('Page.captureScreenshot', { format: 'jpeg', quality: 60 }); writeFileSync(process.argv[2], Buffer.from(s.result.data, 'base64')) }
ws.close()
