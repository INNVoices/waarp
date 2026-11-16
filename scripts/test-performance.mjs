import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = join(root, 'out/test/performance.js')
await build({ absWorkingDir: root, entryPoints: ['test/performance.measure.ts'], bundle: true, platform: 'node', outfile, logLevel: 'warning' })
const result = spawnSync(process.execPath, ['--expose-gc', outfile], { cwd: root, stdio: 'inherit', timeout: 60_000 })
if (result.error) console.error('Configuration performance runner failed:', result.error.code ?? 'unknown')
process.exitCode = result.status ?? 1
