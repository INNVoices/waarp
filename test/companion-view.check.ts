import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { companionSafetyMessage } from '../src/main/companion-view'
import { loadLocale } from '../src/shared/localization'

async function main() {
  // Keep the same imported function across locale changes, as the main process does.
  for (const locale of ['ru', 'en', 'de', 'ru']) {
    const path = locale === 'ru' ? 'src/shared/strings/ru.json' : `src/shared/strings/locales/${locale}.json`
    const expected = JSON.parse(readFileSync(path, 'utf8'))['winInline.index.1580625feb57']
    assert.equal(await loadLocale([locale]), locale)
    assert.equal(companionSafetyMessage(), expected, `companion refusal follows ${locale}`)
  }
  console.log('Companion refusal follows RU → EN → DE → RU without module reload')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
