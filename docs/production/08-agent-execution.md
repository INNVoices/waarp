# 08. Работа агентов и управление production backlog

Здесь описана карта выполнения для Waarp. Это не новый сетевой сервис и не изменение [продуктового companion bridge](../BRIDGE.md). Источник scope — пользовательская концепция, [ROADMAP](../../ROADMAP.md) и карточки восьми корпусов; источник проверяемого статуса — [tasks.json](tasks.json), связанные PR и CI artifacts.

## Минимальный рабочий цикл

1. Получить свежий `origin/main`, прочитать `AGENTS.md`, этот индекс и карточку задачи. Проверить, не закрыт ли дефект другим PR. Не использовать старый SHA как «текущий».
2. Выбрать готовую задачу: `python3 scripts/production-roadmap.py ready --lane ui-localization` или `show UX-001`. Команда читает локальный snapshot; состояние GitHub надо проверить отдельно.
3. В issue корпуса обозначить `ID`, base SHA, branch/worktree, точные owned paths и ожидаемое доказательство. Не присваивать задачу внешнему GitHub-пользователю без оснований. Координатор не даёт двум агентам менять один файл одновременно.
4. Сделать один ограниченный результат. Перед правкой общего workflow/manifest/type contract согласовать владение с текущим исполнителем через координатора. Исследование заканчивать конкретным выводом, patch или воспроизводимым blocker.
5. Выполнить проверки, которые разрешают реальный риск изменения. Сохранить команды, среду, exit codes, artifact hashes и отрицательные результаты. Не расширять прогоны автоматически ради количества тестов.
6. Открыть обычный PR с problem/change/behavior/verification и task ID. Сохранить required Windows check и существующие release gates. После review и обязательного CI слить с проверкой head SHA, обновить task record и issue.
7. Передать следующий конкретный шаг. `done` требует выполненных acceptance criteria; merged diagnostic helper не означает исправленный Android runtime или разрешённый production release.

## Очереди и владение

| Lane | Задачи | Основные пути | Правило параллельности |
| --- | --- | --- | --- |
| release | REL | Android CI, install/emulator/evidence scripts, release docs | Один владелец workflow; Windows и Android validation могут идти отдельно |
| routing-security | NET | main/compiler/shared contracts, Android core/service/data | Сначала контракт, затем platform slice; один owner общего DTO |
| ui-localization | UX, L10N | renderer, Android ui/i18n, locale catalogs | По экрану/языковому пакету; не массовый rewrite всех экранов |
| sticky | STK | Android entry/manifest, будущие sticky types/UI | Spike и recovery до production observer; manifest не редактировать одновременно с REL |
| build | BLD | package/lockfile, Gradle/native manifests, package verifiers | Сначала read-only inventory; изменённый engine возвращает задачу в release gates |
| distribution-growth | DIST, GROW | install/release/site/store metadata, guides | Проверенный current binary и правила площадки; одна запись на submission |
| coordination | OPS | roadmap, registry, root agent instructions | Единственный integrator центральных файлов в конкретной волне |

Agents могут параллельно читать все пути. Исключительное владение относится к изменениям и внешним публикациям. CLI не реализует распределённый lock: согласованная запись в issue и root-координация обязательны для одновременной работы.

## Статусы и зависимости

- `ready`: можно брать сейчас; dependencies выполнены, известного внешнего blocker нет.
- `planned`: спецификация готова; зависимости или очередь ещё не закрыты. Не означает, что функция уже существует.
- `in_progress`: конкретный исполнитель работает; issue/branch показывают ownership.
- `review`: результат находится в PR/review; ещё не доставлен в main.
- `blocked`: назван конкретный gate, ресурс или доказательство, которого нет. Нужен следующий проверяемый шаг, а не абстрактное «ждём».
- `done`: acceptance выполнен, evidence указан, требуемые изменения слиты.
- `deferred`: сознательно отложенная возможность, которая не блокирует текущий production scope.

Неизвестная первопричина — это evidence gap у готовой исследовательской задачи, а не оправдание пропустить её. `depends_on` описывает жесткую последовательность. Связанные темы перечисляются отдельно, чтобы не создавать циклы «проверка требует релиз, релиз требует проверку».

`P0` — препятствие выпуску/безопасному routing, потере данных или управлению. `P1` — существенная удобность и запланированный продуктовый результат. `P2` — улучшение после базовых критериев. Приоритет не является сроком. Новая P0-регрессия вытесняет косметический P1; независимый небольшой P1 можно сделать, пока работает долгий CI.

## Входы/выходы задачи

Карточка содержит ID, title, priority, status, deps, files, change, acceptance и verification. `tasks.json` — навигационный registry с теми же ID, коротким outcome, platform/lane, blockers и ссылкой на полное ТЗ. Если наблюдение изменилось, обновлять обе поверхности одним PR. Исходные dated evidence и неуспешный run сохранять, новый результат добавлять рядом.

Минимальный handoff:

```text
Task: REL-001
Base / head / branch: exact identifiers
Owned paths: exact list
Delivered: bounded behavior change
Verification: commands + environment + results + evidence URLs
Not verified / blocker: exact remaining gate
Next: one concrete action, owner lane, stop condition
```

Secrets, подписывающие ключи, live credentials, полный пользовательский traffic и чужой UI content в task map не попадают. Существующее разрешение пользователя на работу не спрашивать повторно перед обычной обратимой правкой, PR или продолжением исследования. Реальная недоступность ключа/устройства/аккаунта фиксируется как blocker; нельзя выдумывать credentials, получать новые signing identities или обходить запрет площадки.

## Сверка интеграции 22 ноября

Координатор этой волны единолично редактирует task registry и cards. PR #46 (локализация), #47 (Windows inventory/cleanup), #48 (Android inventory), #49 (ledger), #50 и #51 (release preparation) слиты. Сверенный main — [`b3498c2bceab4c38c922bded7e6fc518f30833e7`](https://github.com/INNVoices/waarp/commit/b3498c2bceab4c38c922bded7e6fc518f30833e7). Исторические PR #42/#44 закрывают свои узкие REL-002/REL-009 acceptance, а REL-007 остаётся частично выполненным из-за явно перечисленных NOT_RUN условий.

У PR #46 технический review и CI 44939689471 успешны; общий required CI PR #47 (44940260860) и PR #48 (44940333205) также успешен. Merge SHA: #46 `087a5ff0c3ab0c27e1791c32aa6d50423644086d`, #47 `210a219030a1bd4021f711cd25dff497e8efcd7c`, #48 `4c384a8c21a7b0ec955ae48b316df6aa486b8f61`, #49 `653e4de189b224f540ef335bd32fd193efbd8c37`. [Общий CI main653](https://github.com/INNVoices/waarp/actions/runs/44948724283) успешен для прежнего integration baseline. PR #50 доставлен как `9c14237bcd7efa9a84f13af5d578146dfe26cf7c`; его [общий CI 45052558902/1](https://github.com/INNVoices/waarp/actions/runs/45052558902) завершён success во всех трёх jobs. Отдельный [preview run 45052558924/1](https://github.com/INNVoices/waarp/actions/runs/45052558924) не опубликован после Android route assertion failure; семь Windows assets остаются в draft 454640288. После PR #51 опубликован [preview-2026-11-22-r2](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2) на source `b3498c2bceab4c38c922bded7e6fc518f30833e7`: [release run 45055812375/1](https://github.com/INNVoices/waarp/actions/runs/45055812375) и отдельный [общий main CI 45055812462/1](https://github.com/INNVoices/waarp/actions/runs/45055812462) успешны. Все 12 public assets полностью скачаны и проверены. Отдельный [full Android main run 45055812356/1](https://github.com/INNVoices/waarp/actions/runs/45055812356) имеет 6 success / 1 tracefs refusal / 1 skipped; 7 200 s soak skipped.

- [Runtime recheck](evidence/2026-11-21-ec71-acceptance-recheck.json) сохраняет отдельно успешный preflight и failed full run того же ec71; никакие missing/skipped stages не засчитаны.
- В [main-based PR #48](evidence/2026-11-21-android-inventory-pr48.json) сработал прежний `eventsEnabled=X` / `bpf_trace_printk` guard до APK install. Его fully verified failure archive отделён от range-only APK artifact; advanced PR #45 observer в этот candidate не входит.
- [Windows PR #47 receipt](evidence/2026-11-21-windows-cleanup-pr47.json) относится только к simple-icons slice: actual 9 SVG / 3 portable launches и отдельные 50 native cycles. Новый EXE меньше на 2 915 009 bytes по CI. Original validation ZIP проверен целиком локально; новый EXE локально не скачивался. Runtime-output byte equality относится к отдельному local check; actual CI assets сравнены по paths/sizes.
- [Localization record](evidence/2026-11-21-localization-contract-review.json) отделяет статическую полноту от 57 computed calls, linguistic/visual/device coverage.
- [Package baseline](evidence/2026-11-21-package-baseline-ec71.json), [closure/review record](evidence/2026-11-21-build-continuation-review.json) и [PR #48 sidecars](evidence/2026-11-21-android-inventory-pr48.json) содержат фактические bytes, источник и пределы проверки. Для нового Android artifact проверены selected JSON CRC и поля; весь ZIP digest и новые APK hashes локально не пересчитывались. Ссылки на локальный workspace, временные download credentials и пользовательские payload в ledger не включены.

После подтверждённых merges L10N-002 и BLD-001 имеют статус done; L10N-003/004/006 и BLD-003 — ready. L10N-008 остаётся planned до L10N-006. BLD-002/004 целиком не закрываются Windows icon cleanup. [Published release record](../RELEASES.md#published-preview-2026-11-22-r2) содержит actual source/run/assets, полные download hashes и сравнение сертификатов каждого Android ABI с r5. Новые APK не совместимы с in-place r5 update. Публикация debug preview не заменяет stable gates. Roadmap validator и существующие fixtures проверяют согласование этой документации; дополнительных runtime/soak запусков для неё нет.

## Карточки

### OPS-001

- **title:** Опубликовать единую карту корпусов и исполняемый registry.
- **priority:** P0.
- **status:** `done`: документ принят и слит через [PR41](https://github.com/INNVoices/waarp/pull/41), main `217870599b3ab1913f68bade5bebf8eb44b192f8`; required CI успешен.
- **Dependencies:** нет.
- **files:** `ROADMAP.md`, `AGENTS.md`, `docs/production/`, `scripts/production-roadmap.py`.
- **change:** связать концепцию, старые Э/WN задачи и новый backlog; дать выбор ready tasks, валидатор ID/dependencies/spec links и GitHub issues по корпусам. Не копировать правила других проектов.
- **acceptance:** все задачи имеют ID, конкретный outcome, acceptance и место в одном корпусе; нет cycles/dangling refs. Одна entry page ведёт агента к следующему действию. Старое sticky ТЗ сохранено. Неуспешная production acceptance явно видна.
- **verification:** `python3 scripts/production-roadmap.py check`, `ready`, выбор `show`; ручной review crosswalk и ссылок. Обычный PR с required CI; документация не становится stable release claim.

### OPS-002

- **title:** Поддерживать task/evidence ledger при интеграции каждой волны.
- **priority:** P1.
- **status:** `in_progress` — Сверены merged PR #46–51 и current baseline b3498c2bceab4c38c922bded7e6fc518f30833e7. L10N-002/BLD-001 done; L10N-003/004/006 и BLD-003 ready; L10N-008 planned до L10N-006; BLD-002/004 in_progress. Опубликован preview-2026-11-22-r2 (release 454660754, 2026-11-22 18:50:34 UTC); release run 45055812375/1 и общий main CI 45055812462/1 success. Все 12 public assets полностью скачаны анонимно, bytes/SHA-256 и checksum manifests совпали. У каждого нового Android ABI сертификат отличается от соответствующего r5; in-place update несовместим, migration не проверена. Отдельный полный Android main 45055812356/1: 6 success / 1 tracefs refusal / 1 skipped, 7200 s soak skipped. Старые ec71/PR48 failures и failed unpublished 9c preview сохранены; stable REL gates остаются.
- **Dependencies:** OPS-001.
- **files:** `docs/production/tasks.json`, затронутые corpus cards, соответствующие issues/PR.
- **change:** после merge обновить статус и ссылку, пересчитать readiness, снять ownership, выбрать следующую задачу. Записать новый blocker и точный вариант его проверки. Не переписывать историю неуспешных CI.
- **acceptance:** отсутствуют claims о выполнении без evidence; каждый `review` ведёт к реальному PR; `blocked` содержит причину/next step; ready tasks не ждут уже закрытого dependency. Завершённая automation без recorded runs не считается исполненной.
- **verification:** validator + свежая read-only сверка затронутых GitHub objects; проверять все run attempts при утверждении о конкретном candidate. Один follow-up в issue вместо серии дублирующих комментариев.

### OPS-003

- **title:** Провести пересмотр после первого принятого production candidate.
- **priority:** P2.
- **status:** `planned`.
- **Dependencies:** REL-008, OPS-002.
- **files:** public roadmap, registry, release evidence, issue templates/support docs.
- **change:** сверить реальные установки, сохранность обновления, crash reports, support friction и добровольные отзывы с целями продукта. Удалить дубли backlog, переоценить P1/P2, выбрать следующий ограниченный релиз. Не добавлять скрытую telemetry ради метрик.
- **acceptance:** решения опираются на проверяемые факты; downloads не считаются уникальными активными пользователями, stars не считаются доказанным ростом установок. У новой волны есть критерии входа/выхода и доступные исполнителям задачи.
- **verification:** review release/support/evidence snapshots и обновлённая карта без циклов. Изменение планов не требует полного CI runtime до появления code diff.

## Бюджет исполнения

По умолчанию один PR = один ограниченный риск; допускается пара связанных маленьких UI/i18n исправлений. Долгий эмулятор/soak запускается для candidate или конкретной недоказанной регрессии, а не на каждый редакторский шаг дополнительно к CI. Не отключать установленную обязательную проверку, чтобы сделать быстрее. Рабочие агенты и GitHub Actions активны только фактически; их наличие не означает бессрочную фоновую службу после завершения сессии.
