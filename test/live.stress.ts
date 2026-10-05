import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildConfig, parseConf } from '../src/main/awg'

const SB = join(process.cwd(), 'engine', 'sing-box.exe')
const DIR = join(process.env.TEMP!, 'waarp-stress')
mkdirSync(DIR, { recursive: true })
const CURL = 'C:\Windows\System32\curl.exe'
const keys = execFileSync(SB, ['generate', 'wg-keypair']).toString()
const pk = keys.match(/PrivateKey: (\S+)/)![1], pub = keys.match(/PublicKey: (\S+)/)![1]
const p = parseConf(`[Interface]\nPrivateKey = ${pk}\nAddress = 10.99.0.2/32\nJc = 4\nJmin = 10\nJmax = 50\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\n[Peer]\nPublicKey = ${pub}\nEndpoint = 192.0.2.1:51820\n`)
const cfg = buildConfig([p], { rest: 'direct', groups: [], ruDirect: true, routes: [{ id: 'c', kind: 'app', name: 'curl', exe: CURL, via: p.id, on: true }], dnsAll: false, lanDirect: true, tray: true, autoConnect: false, autostart: false, notify: false }, { api: { port: 19555, secret: 't' } })
const file = join(DIR, 'run.json')
writeFileSync(file, JSON.stringify(cfg))
const ps = (s: string) => execFileSync('powershell', ['-NoProfile', '-Command', s]).toString().trim()
const adapter = () => ps("(Get-NetAdapter -Name Waarp -ErrorAction SilentlyContinue | Measure-Object).Count")
const routes = () => ps("(Get-NetRoute -InterfaceAlias Waarp -ErrorAction SilentlyContinue | Measure-Object).Count")
const web = () => ps("try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 https://www.gstatic.com/generate_204).StatusCode } catch { 'FAIL' }")
const curl = () => { try { execFileSync(CURL, ['-s', '-o', 'NUL', '-w', '%{http_code}', '-m', '6', 'https://www.gstatic.com/generate_204']); return 'LEAK' } catch { return 'blocked' } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

;(async () => {
  console.log('before: adapter', adapter(), 'web', web())
  let bad = 0
  for (let i = 1; i <= 10; i++) {
    const c = spawn(SB, ['run', '-c', file, '-D', DIR, '--disable-color'], { windowsHide: true })
    let log = ''
    c.stdout.on('data', d => (log += d)); c.stderr.on('data', d => (log += d))
    await sleep(3500)
    const a = adapter(), w = web(), k = i <= 3 ? curl() : '-'
    if (i === 1) console.log(log.split('\n').filter(l => /tun|started|ERROR|FATAL/i.test(l)).slice(0, 6).join('\n'))
    i % 2 ? c.kill('SIGKILL') : execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'])
    await sleep(1500)
    const a2 = adapter(), r2 = routes(), w2 = web()
    const okc = a === '1' && w === '204' && (k === '-' || k === 'blocked') && a2 === '0' && r2 === '0' && w2 === '204'
    if (!okc) bad++
    console.log(`#${i} up: adapter=${a} web=${w} curl->tunnel=${k} | killed: adapter=${a2} routes=${r2} web=${w2} ${okc ? 'OK' : 'BAD'}`)
  }
  console.log(bad ? `${bad} BAD cycles` : 'all cycles OK')
})()
