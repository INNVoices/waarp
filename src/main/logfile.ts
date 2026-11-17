import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const STAMPED = /^[+-]\d{4} \d{4}-\d{2}-\d{2} /

const stamp = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export class LogFile {
  readonly file: string
  private size = -1

  constructor(readonly dir: string, private max = 4 * 1024 * 1024, private keep = 5) {
    this.file = join(dir, 'waarp.log')
  }

  write(lines: string[]) {
    try {
      if (this.size < 0) { mkdirSync(this.dir, { recursive: true }); this.size = existsSync(this.file) ? statSync(this.file).size : 0 }
      if (this.size > this.max) this.rotate()
      const now = stamp(new Date())
      const text = lines.map(l => (STAMPED.test(l) ? l : `${now} ${l}`) + '\r\n').join('')
      appendFileSync(this.file, text)
      this.size += Buffer.byteLength(text)
    } catch {}
  }

  private rotate() {
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : join(this.dir, `waarp.${i - 1}.log`)
      try { if (existsSync(from)) renameSync(from, join(this.dir, `waarp.${i}.log`)) } catch {}
    }
    this.size = existsSync(this.file) ? statSync(this.file).size : 0
  }
}
