// Read-only size accounting. Physical package bytes and logical ASAR contents
// are separate views: adding them together would count the application twice.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const physicalGroups = ['application_archive', 'application_external', 'native_engine', 'notices', 'electron_locales', 'electron_runtime', 'remainder']
const applicationGroups = ['main', 'preload', 'renderer_js', 'renderer_css', 'renderer_fonts', 'renderer_maps', 'renderer_sourcemaps', 'renderer_images', 'renderer_other', 'runtime_modules', 'notices', 'remainder']
const normalize = path => path.replaceAll('\\', '/').replace(/^\/+/, '')
const isNotice = path => /(^|\/)(?:licenses?|notices?)(?:\/|\.|$)|(^|\/)(?:third.party.notices|.*-notices)(?:\.|$)/i.test(path)
const top20 = files => [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path, 'en')).slice(0, 20)

export async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export function peArchitecture(path) {
  const descriptor = openSync(path, 'r')
  try {
    const header = Buffer.alloc(64)
    assert.equal(readSync(descriptor, header, 0, header.length, 0), header.length, 'Incomplete PE DOS header')
    assert.equal(header.toString('ascii', 0, 2), 'MZ', 'Expected a PE executable')
    const offset = header.readUInt32LE(60)
    assert.ok(offset >= 64 && offset + 6 <= statSync(path).size, 'Invalid PE header offset')
    const pe = Buffer.alloc(6)
    assert.equal(readSync(descriptor, pe, 0, pe.length, offset), pe.length, 'Incomplete PE header')
    assert.equal(pe.toString('ascii', 0, 4), 'PE\0\0', 'Invalid PE signature')
    const machine = pe.readUInt16LE(4)
    return { machine, architecture: ({ 0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'arm64' })[machine] ?? 'unknown' }
  } finally { closeSync(descriptor) }
}

function grouped(files, names) {
  const groups = new Map(names.map(name => [name, { name, files: 0, bytes: 0 }]))
  for (const file of files) {
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `Invalid file size: ${file.path}`)
    const group = groups.get(file.group)
    assert.ok(group, `Unknown inventory group: ${file.group}`)
    group.files++
    group.bytes += file.bytes
  }
  return [...groups.values()]
}

function physicalGroup(path) {
  if (path === 'resources/app.asar') return 'application_archive'
  if (path.startsWith('resources/app.asar.unpacked/')) return 'application_external'
  if (isNotice(path)) return 'notices'
  if (path.startsWith('resources/engine/')) return 'native_engine'
  if (path.startsWith('locales/')) return 'electron_locales'
  if (!path.includes('/') && /\.(?:exe|dll|pak|dat|bin)$/i.test(path)) return 'electron_runtime'
  return 'remainder'
}

function applicationGroup(path) {
  if (isNotice(path)) return 'notices'
  if (path.startsWith('node_modules/')) return 'runtime_modules'
  if (path.startsWith('out/main/')) return 'main'
  if (path.startsWith('out/preload/')) return 'preload'
  if (path.startsWith('out/renderer/')) {
    if (/\.(?:m?js)$/i.test(path)) return 'renderer_js'
    if (/\.css$/i.test(path)) return 'renderer_css'
    if (/\.(?:woff2?|ttf|otf)$/i.test(path)) return 'renderer_fonts'
    if (/\.map$/i.test(path)) return 'renderer_sourcemaps'
    if (/\.(?:geojson|pmtiles|pbf|mbtiles)$/i.test(path)) return 'renderer_maps'
    if (/\.(?:png|jpe?g|webp|svg|gif|ico|avif)$/i.test(path)) return 'renderer_images'
    return 'renderer_other'
  }
  return 'remainder'
}

function collectPhysical(directory) {
  const files = []
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name)
      const stat = lstatSync(absolute)
      const path = normalize(relative(directory, absolute))
      // Never traverse a package link into a workspace or user data directory.
      assert.ok(!stat.isSymbolicLink(), `Cannot inventory a physical package symlink: ${path}`)
      if (stat.isDirectory()) visit(absolute)
      else {
        assert.ok(stat.isFile(), `Unexpected physical package entry: ${path}`)
        files.push({ path, bytes: stat.size, group: physicalGroup(path) })
      }
    }
  }
  visit(directory)
  return files
}

function runtimeModules(files, archive, asar) {
  const modules = new Map()
  const paths = new Set(files.map(file => file.path))
  for (const file of files) {
    // Attribute a nested dependency to its own package, never to both parent
    // and child. Modules include their notices; this non-additive view is not
    // identical to the runtime_modules group, which excludes those notices.
    const matches = [...file.path.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?=\/|$)/g)]
    const last = matches.at(-1)
    if (!last) continue
    const path = file.path.slice(0, last.index + last[0].length)
    if (!modules.has(path)) {
      const manifest = `${path}/package.json`
      const version = paths.has(manifest) ? JSON.parse(asar.extractFile(archive, join(...manifest.split('/'))).toString('utf8')).version ?? null : null
      modules.set(path, { path, name: last[1], version, files: 0, bytes: 0 })
    }
    const module = modules.get(path)
    module.files++
    module.bytes += file.bytes
  }
  return [...modules.values()].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path, 'en'))
}

export async function windowsPackageInventory({ directory, portable, asar }) {
  const physical = existsSync(directory) ? collectPhysical(directory) : null
  const archive = join(directory, 'resources', 'app.asar')
  const result = {
    schemaVersion: 1,
    accounting: 'File bytes, not filesystem allocation. Portable download, unpacked files and logical ASAR contents are separate non-additive views.',
    portable: existsSync(portable)
      ? { status: 'measured', bytes: statSync(portable).size, sha256: await fileSha256(portable) }
      : { status: 'not_measured', bytes: null, sha256: null, reason: 'Portable input is unavailable.' },
    unpacked: physical
      ? { status: 'measured', bytes: physical.reduce((sum, file) => sum + file.bytes, 0), groups: grouped(physical, physicalGroups), files: physical, top20: top20(physical) }
      : { status: 'not_measured', bytes: null, reason: 'Unpacked input is unavailable.' },
    asar: { status: 'not_measured', bytes: null, reason: 'ASAR input is unavailable.' }
  }
  if (!existsSync(archive)) return result
  const files = [], links = []
  const physicalByPath = new Map(physical.map(file => [file.path, file]))
  for (const entry of asar.listPackage(archive)) {
    const path = normalize(entry)
    const info = asar.statFile(archive, join(...path.split('/')), false)
    if ('files' in info) continue
    if ('link' in info) { links.push({ path, target: normalize(info.link) }); continue }
    assert.ok(Number.isSafeInteger(info.size) && info.size >= 0, `Invalid ASAR file size: ${path}`)
    const storage = info.unpacked ? 'external' : 'packed'
    if (info.unpacked) assert.equal(physicalByPath.get(`resources/app.asar.unpacked/${path}`)?.bytes, info.size, `ASAR external file size mismatch: ${path}`)
    files.push({ path, bytes: info.size, group: applicationGroup(path), storage })
  }
  const bytes = statSync(archive).size
  const packedBytes = files.filter(file => file.storage === 'packed').reduce((sum, file) => sum + file.bytes, 0)
  const externalBytes = files.filter(file => file.storage === 'external').reduce((sum, file) => sum + file.bytes, 0)
  assert.ok(packedBytes <= bytes, 'ASAR file sizes exceed the physical archive')
  result.asar = {
    status: 'measured', bytes, sha256: await fileSha256(archive),
    packedBytes, metadataBytes: bytes - packedBytes, externalBytes,
    logicalBytes: packedBytes + externalBytes,
    accounting: 'packedBytes + metadataBytes = physical app.asar bytes. externalBytes are already counted in unpacked files. Links are aliases with no extra content bytes. Logical groups and runtimeModules must not be added to the physical package total. runtimeModules includes notices attributed to the notices group.',
    classification: 'Groups follow shipped files. Maps, icons and locales bundled into JavaScript remain in the JS group; zero standalone map bytes do not indicate missing map content.',
    groups: grouped(files, applicationGroups), files, links, top20: top20(files), runtimeModules: runtimeModules(files, archive, asar)
  }
  return result
}

export function formatWindowsInventory(inventory) {
  const lines = ['Windows package inventory (bytes; separate, non-additive views)']
  for (const name of ['portable', 'unpacked', 'asar']) {
    const view = inventory[name]
    lines.push(`${name}: ${view.status}${view.bytes === null ? '' : `; ${view.bytes} bytes`}`)
    if (view.status !== 'measured') continue
    if (name === 'asar') lines.push(`  packed=${view.packedBytes}; metadata=${view.metadataBytes}; external=${view.externalBytes}; logical=${view.logicalBytes}`)
    for (const group of view.groups ?? []) lines.push(`  ${group.name}: ${group.bytes} bytes; ${group.files} files`)
    if (view.top20) {
      lines.push(`  Top ${view.top20.length} ${name === 'asar' ? 'logical' : 'physical'} files:`)
      for (const file of view.top20) lines.push(`    ${file.bytes}\t${file.path}`)
    }
  }
  return lines.join('\n') + '\n'
}
