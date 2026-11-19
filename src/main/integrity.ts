import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function verifyEngine(exe: string, bundledExe = exe): boolean {
  try {
    const dir = dirname(exe)
    const manifest = JSON.parse(readFileSync(join(dirname(bundledExe), 'integrity.json'), 'utf8')) as Record<string, string>
    for (const name of ['sing-box.exe', 'libcronet.dll']) {
      const file = join(dir, name)
      if (!existsSync(file) || !/^[0-9a-f]{64}$/i.test(manifest[name] ?? '')) return false
      const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
      if (actual.toLowerCase() !== manifest[name].toLowerCase()) return false
    }
    return true
  } catch { return false }
}

export function stableEngine(exe: string, root: string | undefined): string {
  if (!root) return exe
  try {
    const src = dirname(exe)
    const key = createHash('sha256').update(readFileSync(join(src, 'integrity.json'))).digest('hex').slice(0, 12)
    const dir = join(root, key)
    const target = join(dir, 'sing-box.exe')
    if (verifyEngine(target, exe)) return target
    if (!verifyEngine(exe)) return exe
    mkdirSync(dir, { recursive: true })
    for (const name of ['integrity.json', 'libcronet.dll', 'sing-box.exe']) {
      const part = join(dir, name + '.part')
      copyFileSync(join(src, name), part)
      renameSync(part, join(dir, name))
    }
    return verifyEngine(target, exe) ? target : exe
  } catch { return exe }
}
