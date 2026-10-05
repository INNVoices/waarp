import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Discovery } from '../src/main/discovery'
import { linksInContainer } from '../src/main/links'

let n = 0, bad = 0
const ok = (c: unknown, m: string) => { n++; if (!c) { bad++; console.log('FAIL', m) } }

const json = '{"name":"one","url":"vless:\\/\\/id@example.com:443?type=xhttp\\u0026security=reality#A"}'
const yaml = "proxies:\n  - link: 'trojan://secret@example.net:443?sni=example.net#B'\n  - link: 'ss://YWVzLTEyOC1nY206cA==@198.51.100.2:8388#C'"
const noisy = 'https://example.com vless-not-a-link "vmess://abc" "vmess://abc"'

ok(linksInContainer(json)[0]?.startsWith('vless://') && linksInContainer(json)[0]?.includes('&security='), 'JSON escaped link is normalized')
ok(linksInContainer(yaml).length === 2, 'YAML container yields supported links')
ok(linksInContainer(noisy).length === 1, 'unsupported text is ignored and duplicate links are deduplicated')

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'waarp-discovery-'))
  try {
    const nested = join(root, 'v2rayN', 'subscriptions', 'active'); mkdirSync(nested, { recursive: true })
    const subscription = Buffer.from('trojan://secret@example.net:443?sni=example.net#FromSubscription').toString('base64')
    writeFileSync(join(nested, 'subscription.txt'), subscription)
    const found = await new Discovery().scan([{ path: root, label: 'fixture', maxDepth: 3 }])
    ok(found.length === 1 && found[0].version.startsWith('Trojan'), 'base64 subscription file is discovered')
  } finally { rmSync(root, { recursive: true, force: true }) }

  console.log(bad ? `${bad}/${n} FAILED` : `all ${n} discovery checks passed`)
  if (bad) process.exit(1)
}

void main()
