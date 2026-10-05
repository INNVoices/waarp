// RC2 A: the only square Waarp mark is the "w" of the wordmark (docs/brand/waarp-wordmark-*.svg, first glyph).
// The glyph's 9-unit notch steps are merged into single vertices. No second brand symbol. Used by the tray bitmap and scripts/make-icon.mjs.
export const W_GLYPH: [number, number][] = [
  [172, 970], [16, 460], [148.3, 460], [235.7, 843], [344.3, 460], [459.3, 460],
  [569, 843], [655.3, 460], [783.7, 460], [627.7, 970], [510, 970], [400.2, 591], [289.7, 970]
]
const BOX = { x: 16, y: 460, w: 767.7, h: 510 }

const inside = (px: number, py: number, poly: [number, number][]) => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

/** coverage 0..1 per pixel of a size x size square with the glyph centred at `scale` of the width (4x4 supersampling) */
export function wCoverage(size: number, scale = 0.82): Float32Array {
  const out = new Float32Array(size * size)
  const k = (size * scale) / BOX.w, ox = (size - BOX.w * k) / 2, oy = (size - BOX.h * k) / 2
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let hit = 0
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const gx = (x + (sx + 0.5) / 4 - ox) / k + BOX.x, gy = (y + (sy + 0.5) / 4 - oy) / k + BOX.y
      if (inside(gx, gy, W_GLYPH)) hit++
    }
    out[y * size + x] = hit / 16
  }
  return out
}

/** SVG path of the glyph centred in a size x size box at `scale` of the width (UI mark) */
export function wPath(size: number, scale = 0.86): string {
  const k = (size * scale) / BOX.w, ox = (size - BOX.w * k) / 2, oy = (size - BOX.h * k) / 2
  const f = (v: number) => +v.toFixed(2)
  return 'M' + W_GLYPH.map(([x, y]) => `${f((x - BOX.x) * k + ox)} ${f((y - BOX.y) * k + oy)}`).join('L') + 'Z'
}
