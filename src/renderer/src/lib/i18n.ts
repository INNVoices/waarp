import ru from '../../../shared/strings/ru.json'

const table = ru as Record<string, string>

export function s(id: string, vars?: Record<string, string | number>): string {
  const raw = table[id] ?? id
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : raw
}

export function sp(id: string, n: number): string {
  const a = n % 10, b = n % 100
  const form = a === 1 && b !== 11 ? 'one' : a >= 2 && a <= 4 && (b < 10 || b >= 20) ? 'few' : 'many'
  return s(`${id}.${form}`, { n })
}
