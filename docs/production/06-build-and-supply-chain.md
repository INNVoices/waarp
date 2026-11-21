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

## Карточки задач

### BLD-001

- **title:** Измерить состав доставляемых пакетов.
- **priority:** P1.
- **status:** `ready`.
- **Dependencies:** нет.
- **files:** `scripts/verify-package.mjs`, `scripts/android-verify.py`, `package.json`, `android/app/build.gradle.kts`; создаваемый отчёт в `out/validation/`.
- **change:** расширить текущий package report: размер загрузки, распакованный размер, ASAR entries, runtime modules, renderer JS/CSS/fonts/maps, Electron locales/resources, native engine, notices; отдельно DEX/resources/assets/lib каждого release ABI. У каждого входа зафиксировать SHA, source commit, variant, ABI и tool version. Сравнивать одинаковые platform/variant, не debug с release и не архив AAR с APK.
- **acceptance:** один Windows package и три release APK имеют читаемый top-20 и JSON inventory; сумма групп объясняет весь payload, оставшееся отнесено в явную группу. Secrets, личные профили, tests/fixtures, screenshots и случайные workspace files отсутствуют. Недоступный артефакт отмечен `not_measured`, а не нулём.
- **verification:** обработать реальные CI artifacts с сохранёнными receipts/hashes; package verifier остаётся зелёным. Это read-only анализ артефактов; он не требует новой двухчасовой VPN-сессии. Разница до/после публикуется только после BLD-004.

### BLD-002

- **title:** Выделить необходимый Windows runtime dependency closure.
- **priority:** P1.
- **status:** `planned`.
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
- **status:** `planned`.
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
