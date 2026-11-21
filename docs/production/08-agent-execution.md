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

## Карточки

### OPS-001

- **title:** Опубликовать единую карту корпусов и исполняемый registry.
- **priority:** P0.
- **status:** `review`.
- **Dependencies:** нет.
- **files:** `ROADMAP.md`, `AGENTS.md`, `docs/production/`, `scripts/production-roadmap.py`.
- **change:** связать концепцию, старые Э/WN задачи и новый backlog; дать выбор ready tasks, валидатор ID/dependencies/spec links и GitHub issues по корпусам. Не копировать правила других проектов.
- **acceptance:** все задачи имеют ID, конкретный outcome, acceptance и место в одном корпусе; нет cycles/dangling refs. Одна entry page ведёт агента к следующему действию. Старое sticky ТЗ сохранено. Неуспешная production acceptance явно видна.
- **verification:** `python3 scripts/production-roadmap.py check`, `ready`, выбор `show`; ручной review crosswalk и ссылок. Обычный PR с required CI; документация не становится stable release claim.

### OPS-002

- **title:** Поддерживать task/evidence ledger при интеграции каждой волны.
- **priority:** P1.
- **status:** `planned`.
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
