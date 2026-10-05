import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function verifyEngine(exe: string): boolean {
  try {
    const dir = dirname(exe)
    const manifest = JSON.parse(readFileSync(join(dir, 'integrity.json'), 'utf8')) as Record<string, string>
    for (const name of ['sing-box.exe', 'libcronet.dll']) {
      const file = join(dir, name)
      if (!existsSync(file) || !/^[0-9a-f]{64}$/i.test(manifest[name] ?? '')) return false
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
      if (actual.toLowerCase() !== manifest[name].toLowerCase()) return false
    }
    return true
  } catch { return false }
}
