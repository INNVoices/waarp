// Counts raw <button|select|input|textarea> in renderer .tsx outside ui/kit*.
// Lines with `raw-ok: <reason>` are allowlisted (reason required).
// Fails if any file goes above scripts/raw-ui-baseline.json (new files must be 0). Baseline only shrinks.
// `node scripts/check-raw-ui.mjs --write` rewrites the baseline (only after burning down).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/renderer/src')
const basePath = join(root, 'scripts/raw-ui-baseline.json')
const re = /<(button|select|input|textarea)\b/g

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const counts = {}
const noReason = []
for (const f of walk(src)) {
  const rel = relative(src, f).replaceAll('\\', '/')
  if (/^ui\/kit[^/]*$/.test(rel)) continue
  let n = 0
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const hits = (line.match(re) || []).length
    if (!hits) return
    // allowlist: `raw-ok: <reason>` on the same line (dock tiles, AI chips, kit internals, file inputs...)
    const ok = line.match(/raw-ok:\s*([^*}]*)/)
    if (!ok) { n += hits; return }
    if (ok[1].trim().length < 3) noReason.push(`${rel}:${i + 1}`)
  })
  if (n) counts[rel] = n
}
if (noReason.length) {
  console.error('raw-ui: `raw-ok:` needs a reason (raw-ok: <why>):\n  ' + noReason.join('\n  '))
  process.exit(1)
}
const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
const total = Object.values(counts).reduce((a, b) => a + b, 0)

if (process.argv.includes('--write')) {
  writeFileSync(basePath, JSON.stringify(sorted, null, 2) + '\n')
  console.log(`raw-ui baseline written: ${total} in ${Object.keys(sorted).length} files`)
  process.exit(0)
}

const base = JSON.parse(readFileSync(basePath, 'utf8'))
const bad = []
for (const [f, n] of Object.entries(counts)) if (n > (base[f] ?? 0)) bad.push(`${f}: ${n} (baseline ${base[f] ?? 0})`)
const shrunk = Object.entries(base).filter(([f, n]) => (counts[f] ?? 0) < n)
if (bad.length) {
  console.error('raw-ui: new raw <button/select/input/textarea> outside the kit, use ui/kit instead:\n  ' + bad.join('\n  '))
  process.exit(1)
}
console.log(`raw-ui ok: ${total} raw left${shrunk.length ? `; ${shrunk.length} file(s) below baseline, run with --write to lock it in` : ''}`)
