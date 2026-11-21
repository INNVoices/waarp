// [D-ui-strings] Counts literal UI text in renderer .tsx (docs/design/57-strings.md): JSX text nodes,
// string title/placeholder/aria-label/label props, and t('English literal') calls. UI text lives in
// src/shared/strings/ru.json and is read with s('area.id').
// Lines with `strings-ok: <reason>` are allowlisted (reason required): brand names, key caps, code samples.
// Fails if any file goes above scripts/strings-baseline.json (new files must be 0). Baseline only shrinks.
// `node scripts/check-strings.mjs --write` rewrites the baseline (only after burning down). `--list <file>` prints hits.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@babel/parser' // TS 7 has no JS API; babel's parser ships with the vite toolchain
import { checkLocalization } from './localization-contract.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src/renderer/src')
const basePath = join(root, 'scripts/strings-baseline.json')
const PROPS = new Set(['title', 'placeholder', 'aria-label', 'label', 'tip'])
const LETTER = /\p{L}/u

function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Literal UI text hits in one .tsx source: [{ line, kind, text }]. */
export function scan(text) {
  const ast = parse(text, { sourceType: 'module', plugins: ['jsx', 'typescript'], errorRecovery: true })
  const lines = text.split('\n')
  const hits = []
  const add = (node, kind, s) => {
    if (!LETTER.test(s)) return
    const line = node.loc.start.line
    if (/strings-ok:\s*\S{3,}/.test(lines[line - 1] ?? '')) return
    hits.push({ line, kind, text: s.trim().replace(/\s+/g, ' ') })
  }
  const lit = (e) => !e ? null : e.type === 'StringLiteral' ? e.value : e.type === 'TemplateLiteral' && !e.expressions.length ? e.quasis[0].value.cooked : null
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'JSXText') add(node, 'text', node.value)
    else if (node.type === 'JSXAttribute' && PROPS.has(node.name.name) && node.value) {
      const v = lit(node.value) ?? (node.value.type === 'JSXExpressionContainer' ? lit(node.value.expression) : null)
      if (v != null) add(node, 'prop', v)
    } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't') {
      const v = lit(node.arguments[0])
      if (v != null) add(node, 't()', v)
    }
    for (const k in node) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments') continue
      const c = node[k]
      if (Array.isArray(c)) c.forEach(visit)
      else if (c && typeof c === 'object') visit(c)
    }
  }
  visit(ast.program)
  return hits
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const li = process.argv.indexOf('--list')
  if (li > 0) {
    const f = join(src, process.argv[li + 1])
    for (const h of scan(readFileSync(f, 'utf8'))) console.log(`${h.line}\t${h.kind}\t${h.text}`)
    process.exit(0)
  }
  const counts = {}
  for (const f of walk(src)) {
    const rel = relative(src, f).replaceAll('\\', '/')
    const n = scan(readFileSync(f, 'utf8')).length
    if (n) counts[rel] = n
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  if (process.argv.includes('--write')) {
    writeFileSync(basePath, JSON.stringify(sorted, null, 2) + '\n')
    console.log(`strings baseline written: ${total} literal UI texts in ${Object.keys(sorted).length} files`)
    process.exit(0)
  }
  const contract = checkLocalization(root)
  if (contract.errors.length) {
    const tableBad = contract.errors.map(error => `${error.path}: ${error.code}: ${error.detail}`)
    console.error('strings: localization contract mismatch:\n  ' + tableBad.slice(0, 40).join('\n  ') + (tableBad.length > 40 ? `\n  … ${tableBad.length - 40} more` : ''))
    process.exit(1)
  }
  console.log(`localization contract ok: ${contract.stats.locales} locales; ${contract.stats.windowsKeys} Windows IDs; ${contract.stats.androidKeys} Android literal IDs; ${contract.stats.windowsComputedCalls} computed Windows calls require runtime coverage`)
  const base = JSON.parse(readFileSync(basePath, 'utf8'))
  const bad = []
  for (const [f, n] of Object.entries(counts)) if (n > (base[f] ?? 0)) bad.push(`${f}: ${n} (baseline ${base[f] ?? 0})`)
  const shrunk = Object.entries(base).filter(([f, n]) => (counts[f] ?? 0) < n)
  if (bad.length) {
    console.error('strings: new literal UI text, put it in src/shared/strings/ru.json and use s(\'id\') (node scripts/check-strings.mjs --list <file>):\n  ' + bad.join('\n  '))
    process.exit(1)
  }
  console.log(`strings ok: ${total} literal UI texts left${shrunk.length ? `; ${shrunk.length} file(s) below baseline, run with --write to lock it in` : ''}`)
}
