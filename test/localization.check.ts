import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadLocale, message, plural } from '../src/shared/localization'

async function main() {
  const directory = 'src/shared/strings/locales'
  const android = 'android/app/src/main/assets/locales'
  const files = readdirSync(directory).sort()
  assert.equal(files.length, 18)
  assert.deepEqual(readdirSync(android).sort(), files)
  for (const file of files) {
    const locale = file.slice(0, -5)
    const strings = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    assert.equal(await loadLocale([locale]), locale)
    assert.equal(message('nav.settings'), strings['nav.settings'])
    const rules = new Intl.PluralRules(locale)
    for (const key of Object.keys(strings).filter(key => key.endsWith('.other') && strings[key].includes('{n}'))) {
      const group = key.slice(0, -6)
      for (const n of [0, 1, 2, 3, 5, 11, 21, 101, 1.5, 1000000]) {
        const form = strings[group + '.' + rules.select(n)]
        assert.equal(typeof form, 'string', locale + '/' + group)
        assert.equal(plural(group, n), form.replaceAll('{n}', String(n)))
      }
    }
  }
  assert.equal(await loadLocale(['xx', 'zh-TW']), 'zh-Hant')
  assert.equal(await loadLocale(['pt-PT']), 'pt-BR')
  assert.equal(await loadLocale(['xx']), 'ru')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
