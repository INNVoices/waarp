// One icon pack (D-one-icon-pack): icons come from docs/brand/make-icons.mjs -> assets/icons, drawn via kit <Ico>.
// Counts in renderer .tsx: inline <svg> and unicode glyphs used as icons (a lone glyph as element text or as a
// string literal). Lines with `icon-ok: <reason>` are allowlisted (brand marks, data charts, OS caption).
// Fails if any file goes above scripts/icons-baseline.json (new files must be 0). Baseline only shrinks.
// `node scripts/check-icons.mjs --write` rewrites the baseline (only after burning down). `--list` prints every hit.
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/renderer/src')
const basePath = join(root, 'scripts/icons-baseline.json')
const G = '▦×✕✓✔✗✘⚠▾▸▴▲▼◂▶◀›‹⋯⋮↻⟳⟲★☆✎⧉⊕⊖✚✖➜↗☰⚙⏸■●○◆'
const reSvg = /<svg\b/g
// lone glyph between tags/braces (">×<", "> ✓ {", "}▾<") or as a quoted literal ('×', "▾", `⚠`)
// '×' right before '{' is a count ("×{n}"), not an icon
const reGlyph = new RegExp(`(?:>|\\})\\s*(?:×(?=\\s*<)|[${G.replace('×', '')}]\\s*(?=<|\\{))|['"\`][${G}]['"\`]`, 'gu')

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

const counts = {}
const hits = []
const noReason = []
for (const f of walk(src)) {
  const rel = relative(src, f).replaceAll('\\', '/')
  let n = 0
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\/?\*)/.test(line)) return // comment lines
    const m = [...(line.match(reSvg) || []), ...(line.match(reGlyph) || [])]
    if (!m.length) return
    const ok = line.match(/icon-ok:\s*([^*}]*)/)
    if (ok) { if (ok[1].trim().length < 3) noReason.push(`${rel}:${i + 1}`); return }
    n += m.length
    for (const x of m) hits.push(`${rel}:${i + 1}  ${x.trim().slice(0, 12)}`)
  })
  if (n) counts[rel] = n
}
if (noReason.length) {
  console.error('icons: `icon-ok:` needs a reason (icon-ok: <why>):\n  ' + noReason.join('\n  '))
  process.exit(1)
}
const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
const total = Object.values(counts).reduce((a, b) => a + b, 0)
if (process.argv.includes('--list')) console.log(hits.join('\n'))

if (process.argv.includes('--write')) {
  writeFileSync(basePath, JSON.stringify(sorted, null, 2) + '\n')
  console.log(`icons baseline written: ${total} in ${Object.keys(sorted).length} files`)
  process.exit(0)
}
const base = existsSync(basePath) ? JSON.parse(readFileSync(basePath, 'utf8')) : {}
const over = Object.entries(sorted).filter(([f, n]) => n > (base[f] ?? 0))
if (over.length) {
  console.error('icons: inline <svg> / unicode icon glyphs above baseline. Use a pack icon (<Ico name="set/name"/>, draw missing ones in docs/brand/make-icons.mjs):\n  ' +
    over.map(([f, n]) => `${f}: ${n} (baseline ${base[f] ?? 0})`).join('\n  '))
  process.exit(1)
}
const baseTotal = Object.values(base).reduce((a, b) => a + b, 0)
console.log(`icons ok: ${total} left (baseline ${baseTotal})${total < baseTotal ? ' - run with --write to lower the baseline' : ''}`)
