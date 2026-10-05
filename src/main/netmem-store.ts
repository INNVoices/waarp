// W3 hardening: netmem.json is optional private history. Written only if the OS confirms a private file; if that
// cannot be confirmed the just-written file is removed and memory stays in RAM. Loaded input is validated and pruned.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { parseMem, pruneMem, type NetMemory } from '../shared/netmemory'
import { protectPrivateFile } from './private-file'

export interface MemIo { write(file: string, text: string): void; protect(file: string): void; remove(file: string): void; read(file: string): string }
export const realIo: MemIo = {
  write: (f, t) => writeFileSync(f, t, { mode: 0o600 }),
  protect: protectPrivateFile,
  remove: f => rmSync(f, { force: true }),
  read: f => readFileSync(f, 'utf8'),
}

/** returns whether memory is on disk now */
export function saveMem(file: string, salt: string, mem: NetMemory, now: number, io: MemIo = realIo): boolean {
  try { io.write(file, JSON.stringify({ salt, data: pruneMem(mem, now) })) } catch { try { io.remove(file) } catch { /* nothing to clean */ } return false }
  try { io.protect(file); return true }
  catch { try { io.remove(file) } catch { /* best effort */ } return false }
}

export function loadMem(file: string, now: number, io: MemIo = realIo): { salt: string; data: NetMemory } {
  try {
    const j = JSON.parse(io.read(file)) as { salt?: unknown; data?: unknown }
    if (typeof j.salt === 'string' && /^[0-9a-f]{32}$/.test(j.salt)) return { salt: j.salt, data: pruneMem(parseMem(j.data), now) }
  } catch { /* first run or unreadable: start empty */ }
  return { salt: randomBytes(16).toString('hex'), data: {} }
}
