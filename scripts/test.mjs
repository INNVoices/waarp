// Offline checks only. Native Electron and live network scenarios stay explicit opt-ins.
import { build } from 'esbuild'
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const suites = readdirSync(join(root, 'test')).filter(name => name.endsWith('.check.ts')).sort()
const failed = []
const partial = []
for (const suite of suites) {
  const outfile = join(root, 'out', 'test', suite.replace(/\.ts$/, '.js'))
  try {
    await build({
      absWorkingDir: root, entryPoints: [join('test', suite)], bundle: true, platform: 'node',
      outfile, logLevel: 'warning', alias: { electron: './test/stubs/electron.ts' }
    })
    const result = spawnSync(process.execPath, [outfile], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.stdout?.includes('[SKIP]')) partial.push(suite)
    if (result.status !== 0 || result.error) {
      failed.push(suite)
      if (result.error) console.error(result.error.message)
    }
  } catch (error) { failed.push(suite); console.error(`${suite}: ${error.message}`) }
}
console.log(`Offline suites: ${suites.length - failed.length}/${suites.length} completed without failures`)
if (partial.length) console.log(`Partial coverage (explicit skips): ${partial.join(', ')}`)
if (failed.length) { console.error(`Failed: ${failed.join(', ')}`); process.exitCode = 1 }
