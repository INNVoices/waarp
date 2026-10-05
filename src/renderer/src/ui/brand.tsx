import { siClaude, siDiscord, siGithub, siGooglegemini, siInstagram, siSpotify, siTelegram, siX, siYoutube } from 'simple-icons'

const PATHS: Record<string, { path: string; hex: string }> = {
  youtube: siYoutube, discord: siDiscord, telegram: siTelegram, claude: siClaude, googlegemini: siGooglegemini,
  instagram: siInstagram, x: siX, spotify: siSpotify, github: siGithub
}

export function Brand({ brand, name, color, size = 32 }: { brand?: string; name: string; color: string; size?: number }) {
  const b = brand ? PATHS[brand] : undefined
  const tint = b && b.hex !== '000000' && b.hex !== '181717' ? '#' + b.hex : color
  return (
    <span className="brand-ic" style={{ width: size, height: size, color: tint, background: `color-mix(in oklab, ${tint} 14%, var(--field))`, borderColor: `color-mix(in oklab, ${tint} 28%, transparent)` }}>
      {b
        ? <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill="currentColor" aria-hidden>{/* icon-ok: brand mark from simple-icons (CC0) */}<path d={b.path} /></svg>
        : <b>{name.slice(0, 1)}</b>}
    </span>
  )
}
