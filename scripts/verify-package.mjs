// Verify the actual Windows package, not just electron-builder's requested file patterns.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatWindowsInventory, peArchitecture, windowsPackageInventory } from './package-inventory.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const metadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(resolve(root, 'engine/integrity.json'), 'utf8'))
const resources = resolve(root, 'dist/win-unpacked/resources')
const archive = resolve(resources, 'app.asar')
const portable = resolve(root, `dist/Waarp-${metadata.version}-portable.exe`)
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const entries = new Set(asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\/+/, '')))
const required = ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'build/icon.png', 'node_modules/jsqr/dist/jsQR.js']
for (const path of required) assert.ok(entries.has(path), `Missing application runtime file: ${path}`)
assert.deepEqual(asar.extractFile(archive, join('build', 'icon.png')), readFileSync(resolve(root, 'build/icon.png')), 'The taskbar window icon must be present in the packaged runtime')
const forbidden = [...entries].filter(name => /^(test|docs|src|scripts)(\/|$)/.test(name) || /^out\/(?!main(?:\/|$)|preload(?:\/|$)|renderer(?:\/|$))/.test(name))
assert.deepEqual(forbidden, [], 'Test bundles, source, screenshots and validation reports must not ship in app.asar')
assert.ok(![...entries].some(name => /^node_modules\/simple-icons(?:\/|$)/.test(name)), 'Renderer-bundled brand icons must not ship a second runtime package')
const packagedMetadata = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
assert.equal(packagedMetadata.version, metadata.version, 'Packaged version does not match the candidate')
// asar 3 traverses directory segments using the host path separator.
const html = asar.extractFile(archive, join('out', 'renderer', 'index.html')).toString('utf8')
for (const match of html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)) {
  assert.ok(entries.has(`out/renderer/${match[1]}`), `Missing renderer entry asset: ${match[1]}`)
}
assert.deepEqual(JSON.parse(readFileSync(resolve(resources, 'engine/integrity.json'), 'utf8')), manifest)
for (const name of ['sing-box.exe', 'libcronet.dll']) assert.equal(sha256(resolve(resources, 'engine', name)), manifest[name], `Packaged ${name} checksum changed`)
for (const name of ['LICENSE.txt', 'NOTICE.txt', 'THIRD_PARTY_NOTICES.md', 'engine/LICENSE', 'engine/SOURCE.md', 'engine/CRONET-NOTICES.txt', 'licenses/simple-icons/LICENSE.md']) {
  assert.ok(statSync(resolve(resources, name)).isFile(), `Missing distribution notice: ${name}`)
}
const report = {
  version: metadata.version, commit: process.env.GITHUB_SHA ?? null, passed: true,
  noTestBundlesOrReports: true, runtimeEntriesPresent: true, windowIconPresent: true, packagedEngineMatchesPin: true,
  rendererOnlyIconsExcluded: true, brandNoticePresent: true,
  asarBytes: statSync(archive).size, asarEntryCount: entries.size,
  portableBytes: statSync(portable).size, portableSha256: sha256(portable), engineVersion: manifest.version
}
report.inventory = await windowsPackageInventory({ directory: resolve(root, 'dist/win-unpacked'), portable, asar })
report.inventory.context = {
  platform: 'windows', variant: 'portable', version: metadata.version,
  runtimeExecutable: { file: `${metadata.productName}.exe`, ...peArchitecture(resolve(root, 'dist/win-unpacked', `${metadata.productName}.exe`)) },
  sourceCommit: report.commit, sourceCommitBasis: report.commit ? 'GITHUB_SHA of the verifier/build job; requires the matching build receipt' : 'not_recorded',
  tools: { node: process.version, asar: require('@electron/asar/package.json').version },
  installedBuildTools: { electron: require('electron/package.json').version, electronBuilder: require('electron-builder/package.json').version }
}
mkdirSync(resolve(root, 'out/validation'), { recursive: true })
writeFileSync(resolve(root, 'out/validation/package-integrity.json'), JSON.stringify(report, null, 2) + '\n')
writeFileSync(resolve(root, 'out/validation/package-inventory.txt'), formatWindowsInventory(report.inventory))
console.log(JSON.stringify({ ...report, inventory: { context: report.inventory.context, unpackedBytes: report.inventory.unpacked.bytes, asarLogicalBytes: report.inventory.asar.logicalBytes } }))
console.log(formatWindowsInventory(report.inventory))
