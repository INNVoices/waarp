# 05. Локализация: качество, переключение языка и устойчивость

**Историческое основание:** `main` `63fc7930abfeac1b870e9c8e3fabc500768f419e`, чтение и статическая сверка JSON 2026-11-21. Новые языковые ресурсы не генерировались; лингвистическая вычитка носителями и запуск на телефоне/Windows в этот аудит не входят.

**База продолжения:** `b3498c2bceab4c38c922bded7e6fc518f30833e7` после [PR #51](https://github.com/INNVoices/waarp/pull/51). Исторические CI/измерения ниже сохраняют свой source; новый preview учитывается в [release record](../RELEASES.md#published-preview-2026-11-22-r2).

## 1. Уже реализовано

Локализация начинается не с нуля. В репозитории есть **19 языков**: `ru`, `en`, `de`, `fr`, `es`, `pt-BR`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `uk`, `it`, `pl`, `tr`, `ar`, `hi`, `id`, `vi`, `fa`.

| Слой | Фактическая реализация |
| --- | --- |
| Windows shared | `src/shared/localization.ts`: RU базовая таблица, 18 dynamic loaders, порядок системных preferences, `Intl.Locale`, китайский script fallback, `pt-* → pt-BR`, RU fallback, `Intl.PluralRules` |
| Windows renderer | `src/renderer/src/main.tsx` загружает язык до App; задаёт HTML lang и RTL для ar/fa; `lib/i18n.ts` экспортирует message/plural |
| Windows main | `src/main/index.ts` вызывает `loadLocale(app.getPreferredSystemLanguages())` в `whenReady`; native menus/errors используют `localized` |
| Android | `i18n/Localization.kt`: 18 JSON assets и RU literal fallback; `WaarpApplication` конфигурирует язык при старте/изменении Configuration; manifest содержит `localeConfig` и `supportsRtl` |
| Android system picker | `res/xml/locales_config.xml` перечисляет 19 языков; это уже подготовка системного per-app выбора, а не отсутствующая функция |
| Тесты | `test/localization.check.ts` проверяет набор locale-файлов, выбор языка и Windows plural forms; `test/ui.browser.mjs` имеет EN, zh-TW, ar-EG, fa-IR navigation/lang/dir smoke |

Префикс Android Kotlin-файлов: `android/app/src/main/java/local/waarp/android/`.

### Статическая сверка этого прохода

- Windows RU содержит **1 434 ключа**. Во всех 18 locale JSON найдены все эти ключи; различий наборов `{placeholder}` у сопоставленных значений не найдено. Дополнительные ключи plural categories не считаются мусором: по 13 в большинстве таблиц и 39 в Arabic.
- Каждый Android locale JSON содержит **1 088 ключей**. По literal вызовам `localized("id", "fallback", ...)` статический сканер извлёк **1 087 уникальных ID**; все покрыты во всех 18 таблицах, конфликтующих fallback для одного ID и расхождений проверенных `{argN}`/printf-подстановок не обнаружено. Это ограниченный regex-скан, не полный Kotlin parser и не доказательство отсутствия динамических IDs.
- Windows и Android имеют разные UI-словари. Равенство файлов между платформами не требуется; общий glossary и соответствие собственным call sites требуются.
- Полнота ключей не доказывает точный смысл, естественный язык, корректный bidi, геометрию или отсутствие fallback при runtime error.

Источники: [Windows runtime](../../src/shared/localization.ts), [Android runtime](../../android/app/src/main/java/local/waarp/android/i18n/Localization.kt), [localeConfig](../../android/app/src/main/res/xml/locales_config.xml), [проверка](../../test/localization.check.ts), [browser smoke](../../test/ui.browser.mjs).

## Интеграция 22 ноября: структурный контракт принят

[PR #46](https://github.com/INNVoices/waarp/pull/46), head `96d4965ca909e29be62dd7c95c38b296ab741785`, расширяет существующий `npm run check` на реальную структуру Windows и Android каталогов. [Record](evidence/2026-11-21-localization-contract-review.json) фиксирует 19 языков, 1 434 Windows ID, 1 087 Android literal ID, 19 отрицательных mutation fixtures и 66 локальных offline suites без failures. Это проверка структуры; linguistic, visual, RTL и device acceptance остаются отдельными.

Технический review и [CI 44939689471](https://github.com/INNVoices/waarp/actions/runs/44939689471) приняты: все три jobs успешны, включая Windows UI, native lifecycle и portable checks. PR #46 слит как [`087a5ff0c3ab0c27e1791c32aa6d50423644086d`](https://github.com/INNVoices/waarp/commit/087a5ff0c3ab0c27e1791c32aa6d50423644086d). Интеграционный main `653e4de189b224f540ef335bd32fd193efbd8c37` также прошёл [общий CI 44948724283](https://github.com/INNVoices/waarp/actions/runs/44948724283). Исторический record выше не переименован в новый runtime test.

Windows call sites читаются через AST, Android literal calls — через ограниченный Kotlin lexer. Проверяются имена и повторяемость placeholders, границы `argN`, CLDR forms, registry/assets/manifest, дубли и типы значений. Для реальных Android `format()` consumers проверяется весь printf-контракт, включая незавершённый `%`, неизвестную conversion и введённый спецификатор при пустом исходном формате. Комментарии и literal code examples не создают ложные IDs.

57 вычисляемых Windows calls не объявлены статически разрешёнными. Существующий RU fallback для дробного числа сохранён; runtime, переводы и baseline не переписаны. После подтверждённого merge L10N-002 закрыт; L10N-003, L10N-004 и L10N-006 готовы. L10N-008 дополнительно требует завершения L10N-006 и остаётся planned до glossary/review результата.

## 2. Конкретные риски

| Наблюдение | Следствие | Статус доказательства |
| --- | --- | --- |
| До PR #31 `src/main/index.ts:1552` вычислял `COMPANION_SAFE = localized(...)` на уровне модуля; таблица изначально RU, загрузка preferred locale происходит позже | Это сообщение фиксируется на RU и не следует последующим изменениям языка | Исторический дефект порядка инициализации; закрыт L10N-001 / PR #31 |
| До PR #46 `scripts/check-strings.mjs` смотрел верхний каталог strings и вызовы s/sp; locale JSON находятся в `strings/locales`, а новые inline IDs вызываются через localized | Существующий check не является полным контрактом всех платформ/переводов | Исходный пробел покрытия; структурный gate принят в PR #46 / L10N-002 |
| Android `configure` читает/парсит asset без локального fallback при исключении; `localized` индексирует args по данным template | Повреждённый asset или неверный placeholder могут нарушить старт/отображение | Риск устойчивости; текущие JSON этим аудитом не признаны повреждёнными |
| Renderer `mount()` ожидает dynamic import без отдельного error/fallback UI | Ошибка locale chunk должна быть локальной ошибкой, а не бесконечным пустым окном | Условный failure case; L10N-004 |
| CSS содержит physical sides; `fmtBytes/fmtSpeed` Windows используют toFixed, Android форматирует по Locale.getDefault | RTL и формат чисел требуют проверки с эффективным языком приложения | Не утверждается, что все RTL/числовые экраны сломаны |

## 3. Продуктовый контракт языка

1. Явный пользовательский выбор приложения имеет приоритет над системным, «Как в системе» — отдельное значение. Неподдерживаемый preference выбирает следующий поддерживаемый; при отсутствии — документированный RU fallback текущей версии.
2. Main/renderer/native dialogs/notifications используют один эффективный язык или явно задокументированное ограничение до завершения миграции. Locale не хранится внутри VPN-профиля и не меняет routing config.
3. Переключение языка не перезапускает VPN, не сбрасывает черновик, выбранную вкладку и видимый результат диагностики. Android Activity recreation допустима только с сохранением UI state и независимостью service.
4. Параметры протокола, IDs, URL, IP, ключи и машинные reason codes не переводятся. В UI переводится объяснение; технические значения отображаются с безопасной bidi-изоляцией.
5. Переводчик получает смысл, контекст и placeholders. Нельзя превращать «сохранено» в «подключено», «не проверено» в «не работает», а публичный endpoint — в обещание безопасного VPN.
6. Состояния качества языка фиксируются отдельно: structural coverage, визуальный smoke, терминологическая вычитка. Уже имеющиеся 19 языков не объявляются полностью вычитанными и не удаляются молча.

## 4. Исполняемые карточки

### L10N-001

- **priority:** P1 — ближайший узкий PR вместе с UX-001.
- **status:** `done` — PR31 слит после успешного общего Windows CI; protected behavior сохранено.
- **Dependencies:** нет.
- **files:** `src/main/index.ts` (четыре места отказа), `src/main/companion-view.ts` (новый presentation helper), `test/companion-view.check.ts`; `src/shared/localization.ts` и существующие таблицы используются без изменений.
- **change:** получать companion safety message в момент отказа, а не при загрузке модуля. Сохранить тот же ключ `winInline.index.1580625feb57`, исходный смысл, условия проверки, returned DTO и IPC.
- **acceptance:** при RU → EN → ещё один поддерживаемый язык → RU каждый следующий отказ показывает актуальную строку; не требуется повторный import модуля. Безопасные/небезопасные пути, статус saved/applied и набор отказов остаются прежними.
- **verification:** новый unit-сценарий RU → EN → DE → RU без reload модуля и существующий `localization.check.ts` выполнены успешно через тот же esbuild-подход, что `scripts/test.mjs` (версия 0.25.12 из lockfile, offline cache). Значения сравниваются с существующими JSON. Review четырёх call sites: изменилось только время получения строки. Native VPN runtime не нужен и не запускался. Финальный результат PR31: typecheck, unit suites, browser UI, native lifecycle, package verification и общий CI успешны; PR слит как 0e2a23b17dd5e89609917beed3f5b1a2d563021b.

### L10N-002

- **priority:** P1.
- **status:** `done` — PR #46 слит как 087a5ff0c3ab0c27e1791c32aa6d50423644086d. Структурный gate для 19 языков, 1 434 Windows ID и 1 087 Android literal ID; сохранённый review record содержит 19 negative mutations и 66 local offline suites без failures. CI 44939689471: все 3 jobs success, включая Windows UI/native/portable; общий CI интегрированного main653 также успешен. 57 computed Windows calls вне статической гарантии; runtime, catalogs и baseline не менялись.
- **Dependencies:** нет.
- **files:** `scripts/check-strings.mjs`, `scripts/localization-contract.mjs`, `test/localization.check.ts`, `test/localization-contract.check.ts`. Существующие runtime, locale catalogs и manifest читаются без изменения.
- **change:** дополнить существующий gate фактической структурой каталогов: IDs каждого UI, placeholders и их multiplicity, printf-форматы, обязательные plural categories, locale registry/manifest consistency. Обрабатывать Windows и Android как два словаря; не требовать бессмысленной идентичности их ключей. Исправить устаревшие сообщения check про `en.json`, когда base — `ru.json`.
- **acceptance:** удалённый использующийся ID, изменённый argN, неверный формат, недостающая plural category и отсутствующий asset обнаруживаются до сборки; легальные дополнительные CLDR forms проходят; комментарии/пример кода не создают ложные ошибки. Не переписывать baseline вверх ради зелёного CI.
- **verification:** 19 отрицательных mutation fixtures и существующий позитивный набор. Статический gate запускается один раз; Android emulator и сеть для него не требуются. Required CI выполнен отдельно и успешен.

### L10N-003

- **priority:** P1.
- **status:** `ready` — L10N-002 слит; задача свободна по выполненной зависимости.
- **Dependencies:** L10N-002.
- **files:** `src/shared/localization.ts`, `src/main/index.ts`, settings/storage/preload contract, `src/renderer/src/main.tsx`, `pages/settings.tsx`; Android `i18n/Localization.kt`, `WaarpApplication.kt`, `ui/DiagnosticsSettings.kt` и locale configuration.
- **change:** определить единый effective locale и добавить явный выбор языка/«Как в системе». Windows main передаёт renderer согласованный выбор. Android переиспользует уже объявленный system picker на API 33+; для API 29–32 отдельно выбрать поддерживаемый implementation path, не заменяя автоматически всю Activity-иерархию на новую библиотеку.
- **acceptance:** выбор сохраняется, возвращение к system работает, региональные zh/pt fallback объяснимы; UI и native сообщения совпадают; текущая VPN-сессия и черновик не меняются. Не требовать перезапуск всего приложения только ради строки.
- **verification:** RU/EN/de, zh-TW, unsupported → supported preferences; 3 смены языка в открытой форме и один restart UI. На Android отдельно API 29 и 33+; непроверенная версия не получает обещание runtime switch. Первичный источник: [per-app language preferences](https://developer.android.com/guide/topics/resources/app-languages).

### L10N-004

- **priority:** P1.
- **status:** `ready` — L10N-002 слит; задача свободна по выполненной зависимости.
- **Dependencies:** L10N-002.
- **files:** `src/shared/localization.ts`, `src/renderer/src/main.tsx`, Android `i18n/Localization.kt`, `WaarpApplication.kt`; unit tests загрузчика/formatter.
- **change:** локализовать failure boundary: missing/invalid locale asset или неверный template не останавливает запуск и не закрывает работающий VPN. Загружать и валидировать новую таблицу до её атомарной публикации; сохранять last-good/RU fallback и безопасный diagnostic code без UI payload.
- **acceptance:** повреждённая JSON, missing chunk, неверный arg index и отсутствующий key дают определённый fallback; partial table не становится активной; язык runtime не утверждает успешное переключение при отказе загрузки. Не маскировать остальные ошибки приложения глобальным catch.
- **verification:** 4–6 loader/formatter unit fixtures; один renderer failed-import smoke. Production resources не портить на месте; инъекция только в тесте. Не нужен полный native lifecycle прогон, если service code не менялся.

### L10N-005

- **priority:** P1.
- **status:** `planned`
- **Dependencies:** L10N-003, UX-004, UX-005.
- **files:** `src/renderer/src/layout.css`, `styles.css`, `ui/tooltip.tsx`, route/server inputs; Android `ui/WaarpApp.kt`, `ui/HomeRoutes.kt`, `ui/UiComponents.kt`, map/list controls.
- **change:** пройти ar/fa и длинный LTR/CJK по реальной геометрии. Использовать logical CSS там, где сторона зависит от языка; directional icons зеркалить по смыслу, а числовые графики/протоколы — нет. Изолировать домены, IP, paths и ключи от bidi UI-текста.
- **acceptance:** navigation, tooltip, modal, ошибки и последний action читаются и доступны; Tab/Back следуют предсказуемой последовательности; копирование URL/ключа сохраняет точные bytes; язык не меняет то, какой сервер/маршрут выбран.
- **verification:** по одному representative экрану import/route/settings на ar/fa, de и zh-Hant; 900 × 600 desktop и 360 dp Android, один крупный fontScale. Тест `document.dir` сохранить как smoke, но не выдавать за геометрическую приёмку.

### L10N-006

- **priority:** P1 для RU/EN и опасных для смысла строк; P2 для полной вычитки остальных языков.
- **status:** `ready` — L10N-002 слит; задача свободна по выполненной зависимости.
- **Dependencies:** L10N-002.
- **files:** оба locale catalog, исходные Android fallback, glossary/context metadata в documentation без секретов.
- **change:** создать короткий согласованный glossary: маршрут, подключение/туннель, Auto, Direct, public endpoint, сохранено, применено, проверено, восстановление, restart. Проверить прежде всего ON/OFF, consent, destructive actions, ошибки и privacy claims; затем остальные 18 языков небольшими пакетами.
- **acceptance:** один смысл не получает конфликтующие переводы между платформами; placeholders не переводятся; бренд/протокол сохраняются; каждому language batch присвоены reviewer/provenance и фактический статус. Машинная или AI-подготовка не выдаётся за native human review.
- **verification:** 30 критических строк RU/EN, затем до 30 строк на язык за один review batch. Structure checks после редактирования; screenshots только затронутых форм. Участие владельца нужно лишь при спорном продуктовом смысле, не для каждой запятой.

### L10N-007

- **priority:** P2.
- **status:** `planned`
- **Dependencies:** L10N-003.
- **files:** `src/renderer/src/ui/kit.tsx` (`fmtBytes`, `fmtSpeed`, `fmtDur`), отображение дат в `pages/settings.tsx`; Android `ui/UiComponents.kt`, `ui/DiagnosticsSettings.kt`.
- **change:** согласовать локализованные числа, единицы, время и plural с effective locale. Машинные payload/config остаются locale-independent; UI использует locale-aware formatter там, где это улучшает чтение. Не округлять unknown до измеренного нуля.
- **acceptance:** RU/de separator, English units, Arabic direction и plural имеют корректный вид; export/config bytes не меняются; значение 0, дробь, большой объём и unknown различимы. Термин KB/MB соответствует фактическому делителю и документированному выбору.
- **verification:** таблица 8 значений × 3 representative locales плюс existing plural categories; deterministic unit outputs, без сетевых измерений.

### L10N-008

- **priority:** P2.
- **status:** `planned`
- **Dependencies:** L10N-002, L10N-006.
- **files:** locale catalogs, CONTRIBUTING localization section или отдельная документация, CI invocation существующего gate.
- **change:** сделать процесс обновления переводов воспроизводимым: контекст для нового ID, явные renamed/deleted IDs, отдельный статус structural/visual/linguistic review, small review batches. Не генерировать все языки заново при одном изменении строки.
- **acceptance:** агент добавляет новый UI-текст без hardcoded literal, проверяет placeholders и сообщает untranslated/review-needed состояние; понятен владелец glossary; удаляются только доказанно неиспользуемые ключи с учётом dynamic IDs/plurals.
- **verification:** один учебный fixture нового ID проходит workflow и затем удаляется из deliverable; документация содержит точную команду gate и ограниченную матрицу. Дополнительная translation service/telemetry не обязательна.

## 5. Порядок и критерий завершения

Сначала L10N-001 — конкретный дефект; L10N-002 — структурный контракт. Затем L10N-003/004 можно разделить по владельцам файлов, после них — RTL/геометрия и вычитка. Не маркировать весь язык production-ready только по наличию JSON. Перед релизом зафиксировать состояние каждого языка и подтверждённые платформы; внешний переводчик или языковой reviewer не получает конфиги, токены, server URLs либо пользовательские диагностические отчёты.

Официальные основы: [Android localization и default resources](https://developer.android.com/guide/topics/resources/localization), [Android per-app languages](https://developer.android.com/guide/topics/resources/app-languages), [Compose semantics](https://developer.android.com/develop/ui/compose/accessibility/semantics). Эти страницы не доказывают качество конкретных переводов Waarp; оно подтверждается проверками выше.
