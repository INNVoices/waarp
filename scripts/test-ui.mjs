// Serve the production renderer for isolated browser regressions; no Electron process or real tunnel is started.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const renderer = resolve(root, 'out/renderer')
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    if (path === '/favicon.ico') { response.writeHead(204).end(); return }
    const file = resolve(renderer, '.' + (path === '/' ? '/index.html' : path))
    if (!file.startsWith(renderer + sep)) { response.writeHead(403).end(); return }
    const body = await readFile(file)
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    response.end(body)
  } catch { response.writeHead(404).end() }
})

try {
  // Fail usefully if build was omitted instead of spending a browser timeout on a blank page.
  await readFile(resolve(renderer, 'index.html'))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const child = spawn(process.execPath, [resolve(root, 'test/ui.browser.mjs')], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, WAARP_UI_URL: `http://127.0.0.1:${address.port}/` }
  })
  const deadline = setTimeout(() => { console.error('Browser regression deadline exceeded'); child.kill(); }, 180000)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolve(code ?? 1))
    })
  } finally { clearTimeout(deadline) }
} catch (error) { console.error(error); process.exitCode = 1 }
finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
