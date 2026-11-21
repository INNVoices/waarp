import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatWindowsInventory, peArchitecture, windowsPackageInventory } from '../scripts/package-inventory.mjs'

const asar = createRequire(resolve('package.json'))('@electron/asar')

async function main() {
  const temporary = mkdtempSync(join(tmpdir(), 'waarp-package-inventory-'))
  try {
    const source = join(temporary, 'source'), directory = join(temporary, 'win-unpacked')
    const portable = join(temporary, 'portable.exe')
    const write = (base: string, path: string, content: string | Buffer) => {
      const destination = join(base, path)
      mkdirSync(join(destination, '..'), { recursive: true })
      writeFileSync(destination, content)
    }
    write(source, 'package.json', '{"version":"1.0.0"}')
    write(source, 'out/main/index.js', 'main')
    write(source, 'out/preload/index.js', 'preload')
    write(source, 'out/renderer/assets/main.js', 'renderer')
    write(source, 'out/renderer/assets/main.css', 'css')
    write(source, 'out/renderer/assets/font.woff2', 'font')
    write(source, 'out/renderer/assets/main.js.map', 'sourcemap')
    write(source, 'out/renderer/assets/world.geojson', 'map')
    write(source, 'node_modules/example/package.json', '{"version":"2.0.0"}')
    write(source, 'node_modules/example/LICENSE', 'license')
    write(source, 'node_modules/example/addon.node', 'external native file')
    write(source, 'node_modules/example/node_modules/nested/package.json', '{"version":"3.0.0"}')
    write(source, 'node_modules/example/node_modules/nested/index.js', 'nested')
    for (let i = 0; i < 25; i++) write(source, `out/renderer/assets/${i}.svg`, 'x'.repeat(i + 1))
    mkdirSync(join(directory, 'resources'), { recursive: true })
    const archive = join(directory, 'resources/app.asar')
    await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' })
    write(directory, 'resources/engine/sing-box.exe', 'engine')
    write(directory, 'resources/engine/LICENSE', 'notice')
    write(directory, 'locales/ru.pak', 'locale')
    write(directory, 'icudtl.dat', 'electron')
    write(directory, 'unexpected.bin.txt', 'explicit remainder')
    writeFileSync(portable, 'download')
    const inventory = await windowsPackageInventory({ directory, portable, asar })
    const unpacked: any = inventory.unpacked, app: any = inventory.asar
    assert.equal(unpacked.groups.reduce((n: number, g: any) => n + g.bytes, 0), unpacked.bytes)
    assert.equal(app.groups.reduce((n: number, g: any) => n + g.bytes, 0), app.logicalBytes)
    assert.equal(app.packedBytes + app.metadataBytes, statSync(archive).size)
    assert.equal(app.packedBytes + app.externalBytes, app.logicalBytes)
    assert.equal(app.externalBytes, Buffer.byteLength('external native file'))
    assert.equal(unpacked.files.filter((f: any) => f.path === 'resources/app.asar').length, 1)
    assert.equal(unpacked.groups.find((g: any) => g.name === 'application_external').bytes, app.externalBytes)
    assert.equal(app.groups.find((g: any) => g.name === 'renderer_sourcemaps').bytes, 9)
    assert.equal(app.groups.find((g: any) => g.name === 'renderer_maps').bytes, 3)
    assert.equal(unpacked.groups.find((g: any) => g.name === 'remainder').bytes, 18)
    assert.equal(app.runtimeModules.length, 2)
    assert.equal(app.runtimeModules.reduce((n: number, m: any) => n + m.bytes, 0), app.groups.find((g: any) => g.name === 'runtime_modules').bytes + 7)
    assert.equal(app.groups.find((g: any) => g.name === 'notices').bytes, 7)
    assert.deepEqual(app.runtimeModules.map((m: any) => [m.name, m.version]).sort(), [['example', '2.0.0'], ['nested', '3.0.0']])
    assert.equal(app.top20.length, 20)
    assert.ok(app.top20.every((file: any, i: number, all: any[]) => !i || all[i - 1].bytes >= file.bytes))
    assert.match(formatWindowsInventory(inventory), /non-additive/)
    assert.equal(inventory.portable.status, 'measured')
    if (inventory.portable.status === 'measured') assert.match(inventory.portable.sha256, /^[a-f0-9]{64}$/)

    const missing = await windowsPackageInventory({ directory: join(temporary, 'missing'), portable: join(temporary, 'missing.exe'), asar })
    for (const key of ['portable', 'unpacked', 'asar'] as const) {
      assert.equal(missing[key].status, 'not_measured')
      assert.equal(missing[key].bytes, null)
    }
    write(directory, 'resources/app.asar.unpacked/node_modules/example/addon.node', 'changed')
    await assert.rejects(windowsPackageInventory({ directory, portable, asar }), /external file size mismatch/)

    const pe = Buffer.alloc(70)
    pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68)
    writeFileSync(portable, pe)
    assert.deepEqual(peArchitecture(portable), { machine: 0x8664, architecture: 'x64' })
    writeFileSync(portable, 'not a PE')
    assert.throws(() => peArchitecture(portable), /Incomplete PE DOS header/)
    console.log('package-inventory: exact physical and ASAR totals, external bytes, nested modules, maps, top20, unavailable input and PE identity PASS')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
