// RC2 A: regenerates build/icon.png (256 px) from the wordmark w. Run: npx esbuild scripts/make-icon.ts --bundle --platform=node --outfile=out/make-icon.js && node out/make-icon.js
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { wCoverage } from '../src/shared/brand-w'

const S = 256, R = 56, BG = [0x14, 0x13, 0x12], FG = [0xd9, 0x77, 0x57]
const cov = wCoverage(S, 0.62)
// rounded-square background coverage, 4x4 supersampled
const bg = (x: number, y: number) => {
  let h = 0
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
    const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4
    const dx = Math.max(R - px, 0, px - (S - R)), dy = Math.max(R - py, 0, py - (S - R))
    if (dx * dx + dy * dy <= R * R) h++
  }
  return h / 16
}
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  for (let x = 0; x < S; x++) {
    const o = y * (S * 4 + 1) + 1 + x * 4, f = cov[y * S + x], a = bg(x, y)
    for (let k = 0; k < 3; k++) raw[o + k] = Math.round(BG[k] * (1 - f) + FG[k] * f)
    raw[o + 3] = Math.round(a * 255)
  }
}
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), l = Buffer.alloc(4), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6
writeFileSync('build/icon.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
console.log('build/icon.png written')
