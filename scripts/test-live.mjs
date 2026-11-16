// Native adapter lifecycle only; run on an elevated, disposable Windows VM.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verify } from './engine.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (process.platform !== 'win32' || !args.includes('--disposable-windows')) {
  console.error('Requires an elevated disposable Windows VM: node scripts/test-live.mjs --disposable-windows [--report path.json]')
  process.exit(2)
}
try { verify() } catch (error) { console.error(error.message); process.exit(1) }
const outfile = join(root, 'out/test/native-lifecycle.js')
await build({ absWorkingDir: root, entryPoints: ['test/live.stress.ts'], bundle: true, platform: 'node', outfile, logLevel: 'warning' })
const child = spawn(process.execPath, [outfile, ...args], { cwd: root, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
