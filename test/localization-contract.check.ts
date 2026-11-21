import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error This build-time JavaScript gate is also exercised by npm run check.
import { checkLocalization } from '../scripts/localization-contract.mjs'

type Table = Record<string, string>
const windows = 'src/shared/strings'
const android = 'android/app/src/main'
const kotlin = android + '/java/local/waarp/android'
const enPath = windows + '/locales/en.json'
const arPath = windows + '/locales/ar.json'
const androidEn = android + '/assets/locales/en.json'
const base: Table = { 'nav.home': 'Главная', 'win.inline': '{arg1}', 'check.loss': '{n}% проверок', 'count.one': '{n} маршрут', 'count.few': '{n} маршрута', 'count.many': '{n} маршрутов' }
const mobile: Table = { 'Android.hello': 'Value {arg1}, again {arg1}', 'Android.size': '%.2f MB', 'Android.order': '%2$d %1$s', 'Android.noFormat': 'No number' }

function put(root: string, path: string, value: string | Table) {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}
function changeTable(root: string, path: string, change: (table: Table) => void) {
  const value = JSON.parse(readFileSync(join(root, path), 'utf8'))
  change(value); put(root, path, value)
}
function fixture(change?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'waarp-localization-'))
  try {
    put(root, 'src/shared/localization.ts', `const loaders = { en: () => import('./strings/locales/en.json'), ar: () => import('./strings/locales/ar.json') }`)
    put(root, 'src/renderer/src/page.tsx', `import { s, sp } from './lib/i18n'
      import { localized as str } from '../../shared/localization'
      // s('comment.fake')
      const example = "s('example.fake')"
      const conditional = s(Math.random() ? 'nav.home' : 'check.loss')
      const computed = s('nav.' + page)
      export const view = <div>{s('nav.home')}{sp('count', 2)}{str('win.inline', 4)}</div>`)
    put(root, windows + '/ru.json', base)
    put(root, enPath, { ...base, 'check.loss': '{n}% of checks', 'count.other': '{n} routes' })
    put(root, arPath, { ...base, 'count.zero': '{n}', 'count.two': '{n}', 'count.other': '{n}' })
    put(root, kotlin + '/i18n/Localization.kt', `private val supported = setOf("ru", "en", "ar")
      internal fun localized(id: String, fallback: String, vararg args: Any?): String = fallback`)
    put(root, kotlin + '/Screen.kt', `import local.waarp.android.i18n.localized
      // localized("Comment.fake", "ignore")
      /* outside /* localized("Nested.fake", "ignore") */ still comment */
      val example = """localized("Example.fake", "ignore")"""
      val hello = localized("Android.hello", "Значение {arg1}, снова {arg1}", 4)
      val size = String.format(localized("Android.size", "%.2f МБ"), 3.0)
      val order = String.format(localized("Android.order", "%1\\$s %2\\$d"), "name", 4)
      val none = String.format(localized("Android.noFormat", "Без числа"), 1)`)
    put(root, androidEn, mobile)
    put(root, android + '/assets/locales/ar.json', mobile)
    put(root, android + '/res/xml/locales_config.xml', `<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
      <!-- <locale android:name="fake" /> -->
      <locale android:name="ru"/><locale android:name="en"/><locale android:name="ar"/>
      </locale-config>`)
    put(root, android + '/AndroidManifest.xml', `<manifest><application android:localeConfig="@xml/locales_config" /></manifest>`)
    change?.(root)
    return checkLocalization(root)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

const good = fixture()
assert.deepEqual(good.errors, [], 'distinct platform vocabularies, comments, code examples, percentages and explicit printf reordering are valid')
assert.equal(good.stats.androidKeys, 4)
assert.equal(good.stats.windowsComputedCalls, 1)

const mutations: [string, string, (root: string) => void][] = [
  ['removed translated ID', 'missing-id', root => changeTable(root, enPath, table => { delete table['nav.home'] })],
  ['removed used Windows ID even from all tables', 'used-id', root => {
    for (const path of [windows + '/ru.json', enPath, arPath]) changeTable(root, path, table => { delete table['nav.home'] })
  }],
  ['removed used Android ID from every asset', 'missing-id', root => {
    for (const path of [androidEn, android + '/assets/locales/ar.json']) changeTable(root, path, table => { delete table['Android.hello'] })
  }],
  ['changed arg index', 'placeholders', root => changeTable(root, androidEn, table => { table['Android.hello'] = 'Value {arg2}, again {arg2}' })],
  ['changed placeholder multiplicity', 'placeholders', root => changeTable(root, androidEn, table => { table['Android.hello'] = 'Value {arg1}' })],
  ['changed Windows placeholder multiplicity', 'placeholders', root => changeTable(root, enPath, table => { table['win.inline'] = '{arg1} {arg1}' })],
  ['invalid printf format', 'printf', root => changeTable(root, androidEn, table => { table['Android.size'] = '%.2q MB' })],
  ['extra invalid printf conversion', 'printf', root => changeTable(root, androidEn, table => { table['Android.size'] = '%.2f MB %q' })],
  ['trailing percent in printf template', 'printf', root => changeTable(root, androidEn, table => { table['Android.size'] = '%.2f MB %' })],
  ['introduced conversion in a zero-token printf template', 'printf', root => changeTable(root, androidEn, table => { table['Android.noFormat'] = '%d numbers' })],
  ['changed printf precision', 'printf', root => changeTable(root, androidEn, table => { table['Android.size'] = '%.1f MB' })],
  ['missing required plural category', 'plural-category', root => changeTable(root, arPath, table => { delete table['count.zero'] })],
  ['missing Android asset', 'locale-set', root => rmSync(join(root, android + '/assets/locales/ar.json'))],
  ['manifest disconnected from locale config', 'manifest', root => put(root, android + '/AndroidManifest.xml', '<manifest><application/></manifest>')],
  ['XML locale differs from runtime', 'locale-set', root => put(root, android + '/res/xml/locales_config.xml', '<locale-config><locale android:name="ru"/></locale-config>')],
  ['Android registry differs from loaders', 'locale-set', root => put(root, kotlin + '/i18n/Localization.kt', 'val supported = setOf("ru", "en")')],
  ['locale loader points at another asset', 'loader-path', root => put(root, 'src/shared/localization.ts', `const loaders = { en: () => import('./strings/locales/ar.json'), ar: () => import('./strings/locales/ar.json') }`)],
  ['duplicate JSON ID', 'duplicate-id', root => put(root, enPath, readFileSync(join(root, enPath), 'utf8').replace('{', '{"nav.home":"duplicate",'))],
  ['Android placeholder outside supplied arguments', 'argument-count', root => put(root, kotlin + '/Extra.kt', 'val bad = localized("Extra.bad", "{arg2}", 1)')],
]
for (const [name, code, change] of mutations) {
  const result = fixture(change)
  assert.ok(result.errors.some((error: { code: string }) => error.code === code), `${name}: expected ${code}, got ${JSON.stringify(result.errors)}`)
}
assert.deepEqual(fixture(root => changeTable(root, enPath, table => { table['count.zero'] = '{n} routes' })).errors, [], 'legal extra CLDR forms are retained')
console.log(`Localization contract: positive fixtures and ${mutations.length} negative mutations passed`)
