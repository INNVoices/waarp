// WRP-018: explicit, local-only QR scan. Pixels and decoded data never leave this process.
import { desktopCapturer, screen } from 'electron'
import jsQR from 'jsqr'

function rgbaFromBitmap(bitmap: Buffer): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(bitmap.length)
  // Electron's Windows bitmap is BGRA. jsQR expects RGBA.
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    rgba[i] = bitmap[i + 2]
    rgba[i + 1] = bitmap[i + 1]
    rgba[i + 2] = bitmap[i]
    rgba[i + 3] = bitmap[i + 3]
  }
  return rgba
}

export async function scanScreenQr(): Promise<string | null> {
  const displays = screen.getAllDisplays()
  const width = Math.min(4096, Math.max(...displays.map(d => Math.round(d.size.width * d.scaleFactor)), 1920))
  const height = Math.min(2160, Math.max(...displays.map(d => Math.round(d.size.height * d.scaleFactor)), 1080))
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
  for (const source of sources) {
    const image = source.thumbnail
    if (image.isEmpty()) continue
    const size = image.getSize()
    const result = jsQR(rgbaFromBitmap(image.toBitmap()), size.width, size.height, { inversionAttempts: 'attemptBoth' })
    if (result?.data?.trim()) return result.data.trim()
  }
  return null
}
