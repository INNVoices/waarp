import { useEffect, useState } from 'react'

const KEY = 'waarp-dev'
const EVENT = 'waarp-dev-change'

export function readDev(): boolean {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}

export function writeDev(on: boolean) {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY) } catch {}
  window.dispatchEvent(new Event(EVENT))
}

export function useDev(): boolean {
  const [on, setOn] = useState(readDev)
  useEffect(() => {
    const f = () => setOn(readDev())
    window.addEventListener(EVENT, f)
    return () => window.removeEventListener(EVENT, f)
  }, [])
  return on
}
