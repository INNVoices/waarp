// Explicit real-network opt-in. The ordinary offline/CI suites never run this file.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (!args.includes('--engine') || !args.includes('--config') || !args.includes('--report')) {
  console.error('Usage: node scripts/test-connection.mjs --engine /path/to/sing-box --config /private/client.conf --report /path/to/redacted-report.json')
  process.exit(2)
}
const outfile = join(root, 'out/test/connection.live.js')
await build({ absWorkingDir: root, entryPoints: ['test/connection.live.ts'], bundle: true, platform: 'node', outfile, logLevel: 'warning' })
const child = spawn(process.execPath, [outfile, ...args], { cwd: root, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
