# 06. Состав сборки, размер и проверяемая цепочка поставки

**Baseline:** `63fc7930abfeac1b870e9c8e3fabc500768f419e`, аудит 2026-11-21. Цель — убрать доказанно лишнее из доставляемого приложения, сохранив протоколы, языки, офлайн-работу, лицензии и воспроизводимость. Размер репозитория, загружаемого архива, распакованного приложения и runtime-памяти измеряется отдельно.

## Что уже есть

| Область | Наблюдение в исходниках | Следствие для плана |
| --- | --- | --- |
| Windows package | `package.json` задаёт явные `build.files` для трёх runtime-каталогов, иконки и manifest; engine и notices — отдельные `extraResources` | Сначала проверить реальный ASAR/EXE. Список patterns ещё не доказывает отсутствие дублированных dependencies |
| Проверка Windows | `scripts/verify-package.mjs` проверяет runtime, `jsqr`, icon, версии, engine SHA и отсутствие верхних `test/docs/src/scripts`, сохраняет ASAR/EXE bytes | Дополнить существующий отчёт группами, не создавать параллельный несовместимый verifier |
| Renderer dependencies | React, MapLibre, Simple Icons, Inter, Instrument Sans и JetBrains Mono используются в коде; `jsqr` импортируется main | Само наличие пакета не делает его мусором. Отдельно исследовать bundling и фактически необходимый runtime dependency closure |
| Android release | `isMinifyEnabled=true`, `isShrinkResources=true`, три отдельных ABI; universal APK выключен | Не ставить повторную задачу «включить R8/ABI splits». Проверять оставшиеся resources, keep rules и состав native libraries |
| Android native | AAR уже stripped; `keepDebugSymbols` сохраняет проверенные ELF bytes. `native-source.json` задаёт source/submodule/tool pins, patches, tests и tags | Удаление тегов/повторный strip меняют engine. Такой PR требует нового build evidence и protocol matrix |
| Локальный архив | `android/engine/libbox.aar.xz` — 68 015 152 bytes; uncompressed AAR pin — 249 432 428 bytes | Это вход сборки для трёх ABI, а не размер одного APK и не повод удалить офлайн-источник |
| Native libraries | Pin: arm64 84 200 784; armv7 75 747 696; x86_64 88 989 152 bytes | Нужна компонентная матрица; нельзя обещать уменьшение на произвольный процент |
| Лицензии и источник | Windows/Android имеют разные лицензионные границы; engine, Cronet, fonts/maps включают отдельные notices | Notices, source offer/provenance и шрифтовые лицензии не являются мусором |

Источники внутри репозитория: [package](../../package.json), [package verifier](../../scripts/verify-package.mjs), [Gradle](../../android/app/build.gradle.kts), [native recipe](../../android/native-source.json), [AAR integrity](../../android/app/src/main/res/raw/engine_integrity.json), [V1](../V1.md), [предыдущий build audit](../BUILD-AUDIT-2026-11-18.md).

Внешние первичные источники проверены 2026-11-21: [electron-builder v26 contents](https://www.electron.build/v26/docs/contents/) описывает добавление production dependencies к пользовательским file patterns; использовать документацию установленной major-версии. [Android APK Analyzer](https://developer.android.com/studio/debug/apk-analyzer) различает состав и размеры APK и сравнивает артефакты. [Android size guide](https://developer.android.com/topic/performance/reduce-apk-size) рассматривает resources, native packaging и code shrinking. Эти материалы определяют метод проверки, а не доказанный результат Waarp.

## Продолжение 21 ноября: измеренный пакет и ограниченная чистка

[PR #47](https://github.com/INNVoices/waarp/pull/47), head `4ec8a9ecd2fe7b4ebbcc4718db7fa9e12ed8334e`, добавляет Windows inventory и ограничивает поставку simple-icons сборочным этапом. [PR #48](https://github.com/INNVoices/waarp/pull/48), head `53b02066a08d1d19f373c09aa29868f26be05a1a`, добавляет APK inventory. Оба результата пока в review; измерение старого пакета не подменяет новый CI или runtime acceptance.

Общий required CI обоих PR успешен: [Windows/package PR #47 — 44940260860](https://github.com/INNVoices/waarp/actions/runs/44940260860) и [Android inventory PR #48 — 44940333205](https://github.com/INNVoices/waarp/actions/runs/44940333205), по 3 success jobs. Merge ожидает подтверждения владельца. Полный Android run учитывается отдельно ниже.

### Фактический baseline BLD-001

[Полный JSON с группами и top-20](evidence/2026-11-21-package-baseline-ec71.json) относится к PR #45 head `ec71e72d908b29d872d7ca63ae85498e51673270`, tested merge `8266058a051f72a9f124a3485b23b7c148eb8bd7`: [Windows run 44882755093](https://github.com/INNVoices/waarp/actions/runs/44882755093) и [Android run 44882755131](https://github.com/INNVoices/waarp/actions/runs/44882755131). Сохранённые EXE/APK hashes сверены с исходными validation reports.

| Вход | Размер файла, bytes | Распакованные данные, bytes | Граница измерения |
| --- | ---: | ---: | --- |
| Windows x64 portable | 130 906 923 | 544 017 044 | Реальные файлы `win-unpacked`, включая ASAR один раз |
| Android `arm64-v8a` unsigned | 100 505 181 | 102 393 505 | ZIP entries без Android installed/disk claim |
| Android `armeabi-v7a` unsigned | 89 063 579 | 90 950 109 | ZIP entries без Android installed/disk claim |
| Android `x86_64` unsigned | 105 670 372 | 107 563 609 | ZIP entries без Android installed/disk claim |

У Windows `app.asar` занимает 79 509 626 bytes: 78 026 234 content + 1 483 392 metadata; external ASAR bytes — 0. Logical ASAR groups, module rows и physical package — отдельные представления, их нельзя складывать. У APK compressed entry bytes + container overhead равны точному размеру файла; overhead включает headers/alignment/signing metadata. Нулевые standalone map/image groups не означают пропавшие ресурсы: offline map, icons и locale data могут быть внутри JS.

Windows full package verifier выполнен локально на сохранённых исходных EXE/unpacked bytes; local `GITHUB_SHA` не задавался, поэтому новый report не придумывает source attestation. Local inventory tools: Node 24.22.3, ASAR 3.4.1, Python 3.12.14. APK baseline здесь проверен по ZIP и полным SHA против прежних reports; новый local SDK verifier не запускался. [Evidence и ограничения](evidence/2026-11-21-build-continuation-review.json) отличают эти измерения от ранее выполненных CI/static gates.

Отдельный новый [PR #48 build job 136955906954](https://github.com/INNVoices/waarp/actions/runs/44940333222/job/136955906954) успешен: actual SDK verification шести application APK, focused inventory fixtures, JVM/route и native smoke прошли на PR merge `ba9497f9d6eda44a0489e97d96928e5922c07b20`. В [artifact 14721936201](evidence/2026-11-21-android-inventory-pr48.json) обнаружены все 6 static reports и 6 inventory sidecars среди 107 ZIP members; проверены их identity, group sums и CRC выбранных JSON. Прочитаны 100 561 bytes в 42 ranges; весь ZIP digest и новые APK hashes локально не пересчитаны. CI-reported SHA256 трёх unsigned release APK совпадают с ec71 baseline. CI context — Python 3.12.3 / SDK build-tools 35.0.0; он отделён от прежних локальных инструментов. Полная Android runtime matrix и soak этим build job не закрываются; merge ожидает подтверждения владельца.

В том же run API 36 [job 136958307750](https://github.com/INNVoices/waarp/actions/runs/44940333222/job/136958307750) отказал на прежнем main guard `eventsEnabled=X` / `bpf_trace_printk`, до mutation и APK install. Failed archive полностью проверен по SHA256 и 66 raw stream hashes. Это отдельный baseline отказ, не failure нового inventory: неизменённые legacy static fields и APK hashes совпали, а приложение ещё не было установлено. Advanced PR #45 observer не включён в PR #48; его `missing_positive_shared_member` не переносится на этот run.

Android run завершился с **6 success, 1 failure, 1 skipped**: native API 29/35/36 и release API 29/35 успешны, optimized API 36 отказал, 7 200 s soak job 136960519754 пропущен. Успешный общий required Windows check 136955907419 не означает успешную Android production matrix.

В Android `verify()` остаётся детерминированный artifact report. Наблюдения `GITHUB_SHA`/Python/SDK записываются CLI в отдельный `*.validation.inventory.json` sidecar с artifact/SHA/version/ABI. Иначе строгий saved-versus-fresh release replay ошибочно отказал бы на другой машине. Существующий exact comparison не изменён; regression fixture меняет verifier environment и подтверждает неизменность artifact report. Шесть inventory fixtures и 35 existing readiness tests прошли; SDK output подменяется только в обозначенном host fixture.

### Полная Windows dependency closure BLD-002

В baseline найдено **34 packaged modules**. Каждая строка ниже имеет shipped location `app.asar/node_modules/<component>`; версии и bytes взяты из реального ASAR. Module bytes включают notices соответствующего модуля и являются дополнительным представлением, не новой суммой поверх exclusive groups. [Closure/consumer evidence](evidence/2026-11-21-build-continuation-review.json) сохраняет полный список imports, assets, fonts, worker, SVG hashes и license hash.

| Компонент и версия | Baseline bytes | Подтверждённый consumer / dependency | Решение текущей волны |
| --- | ---: | --- | --- |
| `maplibre-gl` 6.19.0 | 29 338 051 | renderer atlas, отдельный worker и встроенная offline map | Сохранить до отдельного packaged map/worker smoke |
| `simple-icons` 16.33.0 | 15 977 615 | девять путей в renderer `App-*.js` | Перенести в dev в PR #47; SVG и license сохранить |
| `react-dom` 19.3.0 | 8 062 585 | renderer React bundle | Сохранить до отдельного packaged closure smoke |
| `@maplibre/maplibre-gl-style-spec` 26.8.0 | 6 660 416 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `@fontsource/inter` 5.3.0 | 4 265 818 | renderer CSS; часть общего набора 50 font assets | Сохранить все scripts/fonts и notices |
| `@maplibre/mlt` 1.3.0 | 1 182 311 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `gl-matrix` 3.4.4 | 654 204 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `@maplibre/geojson-vt` 6.3.3 | 573 112 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `@fontsource-variable/instrument-sans` 5.3.0 | 421 126 | renderer CSS; часть общего набора 50 font assets | Сохранить все scripts/fonts и notices |
| `jsqr` 1.4.0 | 269 401 | external import в `out/main/index.js` (QR) | Сохранить runtime |
| `@fontsource-variable/jetbrains-mono` 5.3.0 | 200 877 | renderer CSS; часть общего набора 50 font assets | Сохранить все scripts/fonts и notices |
| `react` 19.3.0 | 177 421 | renderer React bundle | Сохранить до отдельного packaged closure smoke |
| `bidi-js` 1.1.0 | 160 100 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `earcut` 3.2.4 | 98 021 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `scheduler` 0.28.0 | 82 212 | dependency: `react-dom` | Сохранить в этой волне |
| `zustand` 5.1.0 | 77 791 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `pbf` 5.1.3 | 74 305 | dependency: `@mapbox/vector-tile`, `@maplibre/vt-pbf`, `maplibre-gl` | Сохранить в этой волне |
| `@mapbox/jsonlint-lines-primitives` 2.0.3 | 57 652 | dependency: `@maplibre/maplibre-gl-style-spec` | Сохранить в этой волне |
| `kdbush` 4.1.0 | 31 469 | dependency: `@maplibre/geojson-vt`, `maplibre-gl` | Сохранить в этой волне |
| `protocol-buffers-schema` 3.6.1 | 27 838 | dependency: `resolve-protobuf-schema` | Сохранить в этой волне |
| `@maplibre/vt-pbf` 4.3.3 | 22 998 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `@mapbox/vector-tile` 3.0.0 | 12 433 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `@mapbox/point-geometry` 1.1.0 | 9 875 | dependency: `@mapbox/vector-tile`, `@maplibre/mlt`, `@maplibre/vt-pbf`, `maplibre-gl` | Сохранить в этой волне |
| `@mapbox/tiny-sdf` 2.3.0 | 9 382 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `minimist` 1.2.8 | 8 745 | dependency: `@maplibre/maplibre-gl-style-spec` | Сохранить в этой волне |
| `potpack` 2.1.0 | 5 276 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `json-stringify-pretty-compact` 4.0.0 | 4 180 | dependency: `@maplibre/maplibre-gl-style-spec` | Сохранить в этой волне |
| `murmurhash-js` 1.0.0 | 4 081 | dependency: `maplibre-gl` | Сохранить в этой волне |
| `quickselect` 3.0.0 | 3 414 | dependency: `@maplibre/maplibre-gl-style-spec`, `maplibre-gl` | Сохранить в этой волне |
| `@mapbox/unitbezier` 1.0.0 | 3 267 | dependency: `@maplibre/maplibre-gl-style-spec`, `maplibre-gl` | Сохранить в этой волне |
| `tinyqueue` 3.0.0 | 2 963 | dependency: `@maplibre/maplibre-gl-style-spec`, `maplibre-gl` | Сохранить в этой волне |
| `resolve-protobuf-schema` 2.1.0 | 2 848 | dependency: `pbf` | Сохранить в этой волне |
| `require-from-string` 2.0.2 | 2 436 | dependency: `bidi-js` | Сохранить в этой волне |
| `@types/geojson` 7946.0.16 | 1 726 | dependency: `@mapbox/vector-tile`, `@maplibre/vt-pbf`, `maplibre-gl` | Сохранить в этой волне |

У main есть внешний `jsqr` и относительные locale chunks; preload зависит от Electron. Девять brand SVG уже встроены в renderer. Atlas worker имеет реальный URL в atlas chunk, offline map встроена в этот же chunk, все 50 CSS font references разрешаются. Это source/output evidence. Полный packaged smoke для QR, карты/списка, RU/EN/RTL/CJK и lazy assets остаётся отдельным условием завершения всего BLD-002; текущая узкая чистка не объявляет их заново пройденными.

### Windows slice BLD-004

В PR #47 изменена только категория simple-icons в двух manifests: версия, resolved URL и integrity прежние. Отдельное копирование `LICENSE.md` сохранено. До изменения module занимал **15 977 615 raw ASAR bytes / 3 476 files**. После переноса локальные 19 main + 1 preload + 76 renderer outputs побайтно совпадают; все девять SVG paths остаются в renderer.

Новый [portable lifecycle receipt PR #47](evidence/2026-11-21-windows-cleanup-pr47.json) подтвердил все **9/9 SVG** в настоящем `file://` приложении через Library → Add route → Services на первом запуске. Profile/settings не изменились, master остался OFF. Все **3/3 запуска прошли за 49.745 s** в прежнем 240 s budget, normal exit и owned cleanup успешны. Отдельный native lifecycle завершил **50/50 cycles**. Эти результаты относятся к tested PR merge `8e30505980337b6ba6d957f10d7c958d1ab08736`, не к новому main.

| Представление размера | ec71 baseline, bytes | PR #47, bytes | Экономия |
| --- | ---: | ---: | ---: |
| Physical ASAR | 79 509 626 | 62 643 715 | 16 865 911 (21.212414%) |
| Portable EXE, сжатый payload поставки | 130 906 923 | 127 991 914 | 2 915 009 (2.226780%) |
| Physical unpacked package | 544 017 044 | 527 151 133 | 16 865 911 (3.100254%) |

Эти представления не складываются. Уменьшение ASAR разложено точно: **15 977 615** bytes удалённого logical simple-icons payload + **888 264** bytes ASAR metadata + **32** bytes package.json. Все 91 physical files вне ASAR имеют прежние paths/sizes; `jsqr`, девять SVG и отдельный brand notice сохранены. Runtime outputs были побайтно одинаковыми в отдельной локальной before/after сборке; actual CI candidates сравнены по paths/sizes, а runtime — указанным targeted smoke.

Original validation ZIP **14721747440**, 34 172 bytes, проверен локально по API SHA256, CRC и неизменённой extraction. Новый EXE локально не скачивался: его **127 991 914 bytes** и SHA `2d2337cc9e77727a96730b8f49ebde3da450e2b167984677db5fac58ededb57e` измерены CI и связаны с тремя actual lifecycle запусками; ASAR SHA совпал во всех трёх. Полный [receipt](evidence/2026-11-21-windows-cleanup-pr47.json) сохраняет источник и границы сравнения.

Проверен только Windows simple-icons slice. BLD-004 в целом остаётся in_progress, а merge PR #47 ожидает подтверждения владельца. Остальные Windows module groups, широкий QR/map/language smoke и Android native/ABI/locale/protocol cleanup не объявлены завершёнными. UAC, different-version upgrade/rollback, standard-user ACLs, физические sleep/network/other VPN остаются NOT_RUN.

## Карточки задач

### BLD-001

- **title:** Измерить состав доставляемых пакетов.
- **priority:** P1.
- **status:** `review` — PR #47 (head 4ec8a9e) и PR #48 (head 53b0206) прошли общий required CI; merge ожидает подтверждения владельца. Измерены ec71 baseline 1 Windows + 3 unsigned APK и новый Windows candidate. PR #48 build/SDK verification шести APK и шесть inventory sidecars проверены по selected JSON CRC, identity и group sums; весь новый APK ZIP digest и APK hashes локально не пересчитаны. Windows validation ZIP проверен целиком, новые EXE bytes измерены CI и связаны с actual lifecycle receipt. Strict Android replay сохранён; его полный runtime run имеет baseline guard failure и skipped soak.
- **Dependencies:** нет.
- **files:** `scripts/verify-package.mjs`, `scripts/package-inventory.mjs`, его `.d.mts`, `test/package-inventory.check.ts`, `scripts/android-verify.py`, `scripts/android-package-inventory-test.py`; packaging configuration — `package.json`, `android/app/build.gradle.kts`, создаваемый отчёт — `out/validation/`.
- **change:** расширить текущий package report: размер загрузки, распакованный размер, ASAR entries, runtime modules, renderer JS/CSS/fonts/maps, Electron locales/resources, native engine, notices; отдельно DEX/resources/assets/lib каждого release ABI. У каждого входа зафиксировать SHA, source commit, variant, ABI и tool version. Сравнивать одинаковые platform/variant, не debug с release и не архив AAR с APK.
- **acceptance:** один Windows package и три release APK имеют читаемый top-20 и JSON inventory; сумма групп объясняет весь payload, оставшееся отнесено в явную группу. Secrets, личные профили, tests/fixtures, screenshots и случайные workspace files отсутствуют. Недоступный артефакт отмечен `not_measured`, а не нулём.
- **verification:** обработать реальные CI artifacts с сохранёнными receipts/hashes; package verifier остаётся зелёным. Это read-only анализ артефактов; он не требует новой двухчасовой VPN-сессии. Разница до/после публикуется только после BLD-004.

### BLD-002

- **title:** Выделить необходимый Windows runtime dependency closure.
- **priority:** P1.
- **status:** `in_progress` — Полная таблица 34 packaged modules и actual main/preload/renderer consumers сохранена. jsqr остаётся main runtime dependency; изменяется только simple-icons в PR #47. Остальные React, MapLibre, fonts и transitives сохранены; весь корпус требует отдельного packaged QR/map/language/lazy-asset smoke.
- **Dependencies:** BLD-001.
- **files:** `package.json`, `package-lock.json`, `electron.vite.config.ts`, `src/main/qr.ts`, `src/renderer/src/main.tsx`, `src/renderer/src/ui/brand.tsx`, `src/renderer/src/ui/atlas-canvas.tsx`, `scripts/verify-package.mjs`.
- **change:** сопоставить imports, bundled output, dynamic loading, worker URL и packaged node_modules. Проверить дублирование уже bundled React/MapLibre/icons/fonts. Сохранить main-process `jsqr`, если оно externalized. Удалять пакет/asset только с доказательством отсутствия runtime потребителя; не менять major builder ради новой опции pruning.
- **acceptance:** таблица `component → consumer → shipped location → keep/remove → evidence`; нет глобального запрета node_modules. Atlas worker, offline map, QR import, все заявленные scripts/fonts и notices остаются доступными из packaged `file://` приложения.
- **verification:** packaged smoke для QR, карты/списка, RU/EN/RTL/CJK; проверка lazy assets и imports. Runtime dependency resolution проверяется внутри пакета, а не только в dev server. Отчёт включает bytes потенциальной экономии, даже если безопасное решение — сохранить компонент.

### BLD-003

- **title:** Сопоставить Android native-компоненты с поддерживаемыми функциями.
- **priority:** P1.
- **status:** `planned`.
- **Dependencies:** BLD-001.
- **files:** `android/native-source.json`, `android/native-patches/`, `android/app/build.gradle.kts`, `android/app/proguard-rules.pro`, `scripts/android-core-build.py`, `scripts/android-verify.py`.
- **change:** построить матрицу build tag/library/DEX dependency → importer → compiler → advertised support → native check/interop. Отдельно оценить большие optional protocols и Tailscale omit flags, Cronet/Naive, дубли ресурсов. Зафиксировать, нужен ли compact variant; по умолчанию сохранить один понятный продукт и текущие три ABI.
- **acceptance:** каждое предложение удаления называет потерянную/сохранённую возможность и размерный эффект. Нет отключения supported protocol, ABI, locale или TLS/security path под видом косметической чистки. Если variant действительно нужен, отдельно описаны package/update identity, migration, capability UI и release gates до его внедрения.
- **verification:** анализ recipe/pins, Gradle dependency graph и содержимого реальных APK. Любое изменение native build требует полного воспроизводимого engine build, existing native regression suite, обновления integrity только из проверенного результата и адресного protocol interop. Нельзя редактировать SHA для принятия случайного бинарника.

### BLD-004

- **title:** Удалить подтверждённые дубли и ненужный payload небольшими PR.
- **priority:** P1.
- **status:** `in_progress` — Windows simple-icons slice PR #47 проверен, merge ожидает подтверждения владельца. ASAR: 79 509 626 → 62 643 715 B; portable EXE: 130 906 923 → 127 991 914 B, экономия 2 915 009 B (2.226780%) по CI. Validation ZIP проверен локально; новый EXE локально не скачивался. Все девять SVG и три portable запуска прошли, license сохранена; отдельные local builds дали 96 byte-identical outputs. Весь BLD-004 остаётся in_progress: широкая Windows closure и Android cleanup не завершены.
- **Dependencies:** BLD-002, BLD-003.
- **files:** только установленные BLD-002/003 packaging/resource/dependency paths; `scripts/verify-package.mjs`, `scripts/android-verify.py`.
- **change:** реализовать по одной независимой группе исключений на PR. Windows-only slice может стартовать после BLD-002, Android-only после BLD-003; центральный registry держит общий gate до обеих инвентаризаций. Сначала dev payload/дубли assets, затем доказанные dependencies; архитектурная замена Electron/Compose не входит в эту задачу.
- **acceptance:** сопоставимые before/after artifacts и hash inventory, размер меньше на измеренную величину, отсутствие новых missing resources/функциональных регрессий. Если экономии нет — так и записать; PR без пользы не нужен. Current settings/profiles, все заявленные языки, источник и лицензии сохранены.
- **verification:** package integrity + один targeted scenario на каждый изменённый consumer. При engine/manifest/lifecycle изменениях добавить соответствующий release gate. Revert возвращает прежний payload без миграции пользовательских данных. Никакого `rm -rf` пользовательских caches/profiles для уменьшения размера поставки.

### BLD-005

- **title:** Связать зависимости, лицензии, advisories и воспроизводимость с candidate SHA.
- **priority:** P1; повысить до P0 при подтверждённой блокирующей поставку находке.
- **status:** `ready`.
- **Dependencies:** нет.
- **files:** `package-lock.json`, `android/native-source.json`, `engine/integrity.json`, Android integrity manifest, `.github/workflows/ci.yml`, `.github/workflows/android.yml`, `THIRD_PARTY_NOTICES.md`, `licenses/`, `docs/RELEASES.md`.
- **change:** сверить существующие pinned tools, source recipes, native tests, lockfile и notices. Приложить machine-readable dependency inventory к candidate, разделив shipped runtime/build-only/native. Проверять актуальный advisory и точный range, не переносить старый finding из dated audit на новый lockfile без проверки. Обновления — минимальные, с причиной и changelog.
- **acceptance:** у компонента есть version/source/license и назначение; известная shipped vulnerability имеет исправление или явный release-policy outcome. Воспроизводимость помечается `recipe present`, `rebuilt` или `byte matched` по факту. `npm audit` не считается аудитом Go/ELF; offline bundle verifier не объявляется криптографической CI provenance.
- **verification:** существующие dependency security jobs + source/integrity verifiers; точечный regression после обновления. Обязательные проверки не выключать, lockfile не удалять. Подпись и production identity проходят REL-005, не генерируются заново в build-cleanup задаче.

### BLD-006

- **title:** Закрепить размерные бюджеты и безопасный build/cache lifecycle.
- **priority:** P2.
- **status:** `planned`.
- **Dependencies:** BLD-001, BLD-004.
- **files:** existing build scripts, package verification, CI artifact uploads; документация local builds.
- **change:** зафиксировать baseline budgets по платформе/ABI и группам. Начальный сигнал — рост больше 5% и 5 MiB одновременно, с обязательным объяснением component diff; это предложенный порог, его уточнить по измерениям. Отдельно измерить clean/warm build time и download/cache hit. Cleanup ограничить воспроизводимым build output конкретного workspace.
- **acceptance:** агент видит, какой компонент вырос; уменьшение размера не скрывает пропавший обязательный файл. Cache key зависит от version/hash/toolchain, повреждённый cache отвергается. Доступна локальная clean build без удаления чужих outputs, запущенного EXE или settings. Никаких claims о build speed до измерений на одинаковом runner.
- **verification:** один clean и один warm build, одна intentional oversized fixture для report gate, текущие builder self-tests. Не повторять всю native matrix только ради изменения порога отчёта.

## Порядок работы

BLD-001 и read-only часть BLD-005 можно выполнять параллельно с REL/UX. BLD-002 и BLD-003 исследуют разные платформы; общие manifests и release workflow имеют одного владельца на PR. Чистка считается законченной по реальному пакету и сохранённому поведению. Удаление исторического ТЗ, evidence или исходных notices из Git не считается улучшением доставляемой сборки.
