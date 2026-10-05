import { useEffect, useRef, useState } from 'react'

type Egg = 'pigeon' | 'leaves' | 'snow'

const rnd = (a: number, b: number) => a + Math.random() * (b - a)

export function useEggs(on: boolean) {
  const [egg, setEgg] = useState<Egg>()
  const [k, setK] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const intro = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined)
  const play = (e: Egg, ms: number) => { clearTimeout(hide.current); setEgg(e); setK(x => x + 1); hide.current = setTimeout(() => setEgg(cur => (cur === e ? undefined : cur)), ms) }

  useEffect(() => {
    clearTimeout(timer.current)
    if (!on) return
    clearTimeout(intro.current); clearTimeout(hide.current)
    if (isWinter()) intro.current = setTimeout(() => play('snow', 4200), 500)
    else if (Math.random() < 1 / 12) intro.current = setTimeout(() => play('pigeon', 3200), 900)
    const next = () => { timer.current = setTimeout(() => { play('pigeon', 3200); next() }, rnd(10, 40) * 60000) }
    next()
    return () => { clearTimeout(timer.current); clearTimeout(intro.current); clearTimeout(hide.current) }
  }, [on])

  useEffect(() => {
    const h = () => play('leaves', 3400)
    window.addEventListener('waarp:leaves', h)
    return () => window.removeEventListener('waarp:leaves', h)
  }, [])

  return { egg, k }
}

export const isWinter = () => [11, 0, 1].includes(new Date().getMonth())
export const isNight = () => new Date().getHours() < 5

export function Eggs({ egg, k }: { egg?: Egg; k: number }) {
  if (!egg) return null
  if (egg === 'pigeon') return (
    <svg key={k} className="egg pigeon" viewBox="0 0 40 24" width="34" height="20" aria-hidden>{/* icon-ok: easter egg art */}
      <g className="body">
        <path d="M6 14c4-5 12-6 18-3 3 1 6 1 9-1-1 4-5 7-10 8-6 1-12 0-17-4Z" fill="#9a958f" />
        <circle cx="31" cy="10" r="3.2" fill="#a8a39d" />
        <path d="M34 10l3 1-3 1z" fill="#d97757" />
        <circle cx="32" cy="9.4" r=".7" fill="#141312" />
      </g>
      <path className="wing" d="M14 12c2-7 7-10 12-9-2 4-5 7-12 9Z" fill="#c6c1bb" />
    </svg>
  )
  const n = egg === 'snow' ? 9 : 7
  return (
    <div key={k} className={'egg drift ' + egg} aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <i key={i} style={{ '--dx': `${rnd(-30, 90)}px`, '--dy': `${rnd(-90, 60)}px`, '--r': `${rnd(-200, 200)}deg`, animationDelay: `${i * 0.18}s`, left: `${rnd(0, 20)}px`, top: `${rnd(0, 16)}px` } as React.CSSProperties} />
      ))}
    </div>
  )
}

export function Cat() {
  return (
    <svg className="cat" viewBox="0 0 34 30" width="34" height="30" aria-hidden>{/* icon-ok: easter egg art */}
      <path className="tail" d="M24 27c6 0 8-3 7-7" fill="none" stroke="#2c2a28" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M8 29c-1-6 0-12 4-15l-1-6 4 3h4l4-3-1 6c4 3 5 9 4 15Z" fill="#2c2a28" />
      <circle cx="14.5" cy="15.5" r="1" fill="#e3b040" />
      <circle cx="19.5" cy="15.5" r="1" fill="#e3b040" />
    </svg>
  )
}

let clicks: number[] = []
export function logoClick() {
  const now = Date.now()
  clicks = [...clicks.filter(t => now - t < 2500), now]
  if (clicks.length >= 7) { clicks = []; window.dispatchEvent(new Event('waarp:leaves')) }
}
