import ru from './strings/ru.json'

type Table = Record<string, string>
const loaders: Record<string, () => Promise<{ default: Table }>> = {
  'en': () => import('./strings/locales/en.json'),
  'de': () => import('./strings/locales/de.json'),
  'fr': () => import('./strings/locales/fr.json'),
  'es': () => import('./strings/locales/es.json'),
  'pt-BR': () => import('./strings/locales/pt-BR.json'),
  'zh-Hans': () => import('./strings/locales/zh-Hans.json'),
  'zh-Hant': () => import('./strings/locales/zh-Hant.json'),
  'ja': () => import('./strings/locales/ja.json'),
  'ko': () => import('./strings/locales/ko.json'),
  'uk': () => import('./strings/locales/uk.json'),
  'it': () => import('./strings/locales/it.json'),
  'pl': () => import('./strings/locales/pl.json'),
  'tr': () => import('./strings/locales/tr.json'),
  'ar': () => import('./strings/locales/ar.json'),
  'hi': () => import('./strings/locales/hi.json'),
  'id': () => import('./strings/locales/id.json'),
  'vi': () => import('./strings/locales/vi.json'),
  'fa': () => import('./strings/locales/fa.json'),
}
let table: Table = ru
let plurals = new Intl.PluralRules('ru')

export async function loadLocale(preferences: readonly string[]): Promise<string> {
  let selected = 'ru'
  for (const preference of preferences) {
    try {
      const tag = new Intl.Locale(preference)
      const code = tag.language === 'zh' ? 'zh-' + tag.maximize().script :
        tag.language === 'pt' ? 'pt-BR' : tag.language
      if (code === 'ru' || Object.hasOwn(loaders, code)) { selected = code; break }
    } catch { /* Ignore malformed locale preferences. */ }
  }
  table = selected === 'ru' ? ru : (await loaders[selected]()).default
  plurals = new Intl.PluralRules(selected)
  return selected
}

export function message(id: string, vars?: Record<string, unknown>): string {
  const template = table[id] ?? (ru as Table)[id] ?? id
  return vars ? template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : template
}

export function localized(id: string, ...values: unknown[]): string {
  return message(id, Object.fromEntries(values.map((value, i) => ['arg' + (i + 1), value])))
}

export function plural(id: string, n: number): string {
  const key = id + '.' + plurals.select(n)
  return message(key in table ? key : id + (plurals.resolvedOptions().locale === 'ru' ? '.many' : '.other'), { n })
}
