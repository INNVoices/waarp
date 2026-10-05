import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = join(root, 'engine')
const VERSION = '1.14.2-lx.11'
const ASSET = `sing-box-${VERSION}-windows-amd64.zip`
const URL = `https://github.com/Leadaxe/sing-box-lx/releases/download/v${VERSION}/${ASSET}`
const ARCHIVE_SHA256 = '0a63389570c675aa7a8820c0e0a61fa8c7a7f3346dcec9773b67bbcfc551bc85'
const FILES = ['sing-box.exe', 'libcronet.dll']
const MAX_ARCHIVE = 200 * 1024 * 1024
const TIMEOUT_MS = 5 * 60 * 1000

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function manifest() {
  const m = JSON.parse(readFileSync(join(engineDir, 'integrity.json'), 'utf8'))
  if (m.version !== VERSION) throw new Error(`engine/integrity.json is for ${m.version}, this script pins ${VERSION}`)
  for (const name of FILES) if (!/^[0-9a-f]{64}$/i.test(m[name] ?? '')) throw new Error(`engine/integrity.json has no valid sha256 for ${name}`)
  return m
}

export function verify() {
  const m = manifest()
  const bad = []
  for (const name of FILES) {
    const file = join(engineDir, name)
    if (!existsSync(file)) { bad.push(`${name}: missing`); continue }
    const actual = sha256(readFileSync(file))
    if (actual !== m[name].toLowerCase()) bad.push(`${name}: sha256 ${actual} does not match engine/integrity.json (${m[name]})`)
  }
  if (bad.length) throw new Error(`engine files are not usable:\n  ${bad.join('\n  ')}\nRun: npm run engine:fetch`)
  return m
}

function readZip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(dataStart, dataStart + csize)
    out.set(name, () => (method === 0 ? raw : method === 8 ? inflateRawSync(raw) : (() => { throw new Error(`unsupported zip method ${method} for ${name}`) })()))
  }
  return out
}

async function fetchEngine(archivePath) {
  const m = manifest()
  let zip
  if (archivePath) zip = readFileSync(resolve(archivePath))
  else {
    console.log(`downloading ${URL}`)
    const res = await fetch(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    if (Number(res.headers.get('content-length') ?? 0) > MAX_ARCHIVE) throw new Error(`download refused: archive is larger than ${MAX_ARCHIVE} bytes`)
    zip = Buffer.from(await res.arrayBuffer())
  }
  if (zip.length > MAX_ARCHIVE) throw new Error(`archive is larger than ${MAX_ARCHIVE} bytes; nothing was written`)
  const got = sha256(zip)
  if (got !== ARCHIVE_SHA256) throw new Error(`archive sha256 mismatch: expected ${ARCHIVE_SHA256}, got ${got}; nothing was written`)
  const entries = readZip(zip)
  const staged = []
  for (const name of FILES) {
    const hits = [...entries.keys()].filter((k) => basename(k) === name)
    if (hits.length !== 1) throw new Error(`${name}: expected exactly one entry in the archive, found ${hits.length}; nothing was written`)
    const data = entries.get(hits[0])()
    const actual = sha256(data)
    if (actual !== m[name].toLowerCase()) throw new Error(`${name}: sha256 ${actual} does not match engine/integrity.json (${m[name]}); nothing was written`)
    staged.push([name, data])
  }
  mkdirSync(engineDir, { recursive: true })
  for (const [name, data] of staged) {
    const tmp = join(engineDir, `${name}.part`)
    writeFileSync(tmp, data)
    try { renameSync(tmp, join(engineDir, name)) } catch (e) { rmSync(tmp, { force: true }); throw e }
  }
  verify()
  console.log(`engine ${VERSION}: ${FILES.join(', ')} written and verified against engine/integrity.json`)
}

const [cmd, ...args] = process.argv.slice(2)
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    if (cmd === 'verify') { verify(); console.log(`engine ${VERSION}: ${FILES.join(', ')} match engine/integrity.json`) }
    else if (cmd === 'fetch') {
      const i = args.indexOf('--archive')
      if (i >= 0 && !args[i + 1]) throw new Error('--archive needs a path to the zip')
      await fetchEngine(i >= 0 ? args[i + 1] : undefined)
    } else { console.error('usage: node scripts/engine.mjs <fetch [--archive <local zip>] | verify>'); process.exit(2) }
  } catch (e) { console.error(`engine: ${e.message}`); process.exit(1) }
}
