# Waarp: production roadmap и карта задач для агентов

**Цель:** удобный локальный выбор пути `приложение/домен → Direct / Auto / личное подключение` на Windows и Android. Сначала доказанная надёжность и понятное управление; затем дальнейшее развитие интерфейса, языков, размера поставки, Android «липучки» и распространения. Уже работающие возможности сохраняются.

**Аудит:** 21 ноября 2026; исходный SHA `63fc7930abfeac1b870e9c8e3fabc500768f419e`. Это snapshot, не утверждение о текущем HEAD навсегда. [Parent issue #32](https://github.com/INNVoices/waarp/issues/32) связывает последующие обновления. Карта содержит **8 корпусов и 60 задач**.

## Начать работу

```sh
python3 scripts/production-roadmap.py check
python3 scripts/production-roadmap.py ready
python3 scripts/production-roadmap.py ready --lane ui-localization
python3 scripts/production-roadmap.py show STK-003
```

Команды ничего не меняют и не отправляют в сеть. Перед выбором задачи проверить свежий main, связанный issue/PR и ownership. Полное ТЗ находится по ссылке из [tasks.json](tasks.json); `ready` выводит только незанятые задачи без незакрытых жёстких зависимостей и известных внешних blockers. Условные production gates не блокируют подготовку честно обозначенных preview.

## Карта корпусов

| Корпус | Задачи | Результат | Рабочий issue |
| --- | --- | --- | --- |
| [01. Production и выпуск](01-production-release.md) | REL-001…009 | Связанные runtime evidence, точные пакеты, существующая подпись, установка/обновление и публикация | [#33](https://github.com/INNVoices/waarp/issues/33) |
| [02. Маршрутизация и безопасность](02-routing-and-security.md) | NET-001…006 | Смысл правил/DNS, live apply/rollback, protocol matrix, секреты, offline/revocation | [#34](https://github.com/INNVoices/waarp/issues/34) |
| [03. UI/UX](03-ui-ux.md) | UX-001…008 | Доступность, понятные состояния, фокус, крупный текст, onboarding, отсутствие потери черновиков | [#35](https://github.com/INNVoices/waarp/issues/35) |
| [04. Android «липучка»](04-sticky-companion.md) | STK-001…007 | Восстанавливаемый вход, conditional вызов по событию другого приложения, независимость от VPN | [#36](https://github.com/INNVoices/waarp/issues/36) |
| [05. Мультиязычность](05-localization.md) | L10N-001…008 | Развитие существующих 19 языков: выбор, fallback, placeholders, RTL, вычитка | [#37](https://github.com/INNVoices/waarp/issues/37) |
| [06. Сборка и зависимости](06-build-and-supply-chain.md) | BLD-001…006 | Измеренный состав EXE/APK, удаление дублей, сохранение runtime/лицензий, воспроизводимость | [#38](https://github.com/INNVoices/waarp/issues/38) |
| [07. Дистрибуция и рост](07-distribution-and-growth.md) | DIST-001…006, GROW-001…007 | Проверенная установка, package channels, полезный guide, допустимые submissions и измерение результата | [#39](https://github.com/INNVoices/waarp/issues/39) |
| [08. Работа агентов](08-agent-execution.md) | OPS-001…003 | Владение задачами, PR/CI, статусы и evidence, следующий ограниченный шаг | [#40](https://github.com/INNVoices/waarp/issues/40) |

Каждая карточка содержит priority, status, deps, файлы, изменение, критерии приёмки и способ проверки. Текст «проверить» означает конечный результат: таблицу, артефакт, test, patch или воспроизводимый blocker. Отсутствие evidence само по себе не доказывает дефект приложения.

## Очередность по целям

| Волна | Что делаем | Критерий выхода |
| --- | --- | --- |
| A. Снять production blockers | REL-001/002/003/009, NET-001/004, Windows REL-007; параллельно узкие UX-001 и L10N-001 | Причина каждого отказа классифицирована; проверки не ослаблены; конкретные UI-дефекты исправлены; нет выдуманного «зелёного Android» |
| B. Принять точный candidate | REL-004→005→006, NET-002, BLD-005, затем REL-008 | Один согласованный source/attempt, Android matrix и 7200 s soak, production identity, update/install evidence, Windows lifecycle, release-policy outcome |
| C. Сделать ежедневное использование проще | UX-003→004/005/006/007/008; L10N-002→003/004/005/006; BLD-001→002/003→004 | Понятны saved/applied/verified, формы и маршрут доступны, язык не ломает сессию, payload уменьшен с before/after evidence |
| D. Реализовать исходную «липучку» по проверяемым этапам | STK-001 ADR; STK-002 recovery/entry и STK-003 feasibility; затем observer STK-004 и acceptance STK-005/006 | Есть рабочий обратимый вход; cross-app поведение доказано только для заявленной матрицы; VPN/session не зависит от видимости UI |
| E. Расширять дистрибуцию на готовой основе | DIST + GROW, сохранять полезный onboarding и feedback loop | Manifest проверен настоящей установкой, опубликованный текст совпадает с binary, submissions разрешены и имеют receipts; рост не выдуман |

Это очередность решений, а не жёсткая последовательность всех работ. Read-only build inventory, тексты, locale checks и sticky feasibility могут идти, пока CI проверяет candidate. Важный P0 не ждёт косметической задачи; публикация production-файлов ждёт своих фактических gates. Сроки ставятся по доступности runtime/подписи/устройства и результатам проверки, без обещанных дат до их установления.

### Критический путь Android

```mermaid
flowchart TD
    A["API 29 framework evidence"] --> C["Exact-source matrix + soak"]
    B["API 36 install / tracing evidence"] --> C
    C --> D["Retained production signature"]
    D --> E["Physical install and update"]
    E --> F["Accepted production publication"]
```

Windows acceptance и routing/privacy gates проверяются отдельно и тоже входят в REL-008. Подпись не исправляет runtime, а успешный build не заменяет установку. Если retained key или physical environment недоступны, агент оформляет точный handoff и продолжает независимые ready задачи.

## Что известно сейчас

- `main` имеет source version **1.0.0**, Android version code 7. Публично доступны **Windows r6 0.4.1-rc.5** и **Android r5 0.5.0-rc.5 debug**, оба preview. Версия в исходниках не означает опубликованный stable binary. [Releases](../RELEASES.md).
- Общий CI baseline успешен; полный Android run `44831610512` не прошёл: build/native29/native35/release35 успешны, native36/release29/release36 неуспешны, soak skipped. Точный job ledger — в [корпусе 01](01-production-release.md). [CI](https://github.com/INNVoices/waarp/actions/runs/44831610512).
- **REL-001** слит через [PR #30](https://github.com/INNVoices/waarp/pull/30): ограниченные read-only observations после неудачного install. Локально прошли 10 новых и 32 существующих теста. Реальный collector сохранил ранние SurfaceFlinger crashes и отсутствие package/settings; [derived evidence](evidence/2026-11-21-pr30-install.json). Полное исправление причины этим не заявляется.
- **UX-001 / L10N-001** слиты через [PR #31](https://github.com/INNVoices/waarp/pull/31): два доступных имени кнопок и сообщение companion на актуальном языке. Typecheck, unit suite и browser UI step прошли в [Windows job PR31](https://github.com/INNVoices/waarp/actions/runs/44856670072/job/136700388158); все остальные обязательные этапы CI также успешны, PR слит.
- **GROW-001:** [руководство по первому маршруту](../guides/first-routes.md) подготовлено по исходникам публичных preview. Оно не заявляет новый device test.

Live статусы меняются через task registry и issues. Этот раздел сохраняет основание плана; новый успешный run добавляется как новое evidence, не стирая предыдущий отказ.

## Как сохранена первоначальная концепция

1. **Маршрут — понятное пользовательское намерение.** Direct, Auto, личный сервер и публичный источник не смешиваются. Исчезнувший/отозванный защищённый путь остаётся недоступным. Нет скрытого перехода в Direct/public fallback.
2. **UI не управляет VPN неявно.** Закрытие окна, смена языка, выбор черновика и launcher alias не подменяют ON/OFF или подтверждение применения.
3. **«Липучка» — Android-запрос.** [Оригинал](../ANDROID-CHAMELEON-2026-11-18.md) сохранён. Вызов из выбранного чужого приложения не требует его модификации; доступность события и launch path проверяются. Обычная tray/hotkey-функция Windows не засчитывается за этот результат.
4. **Чистка сохраняет возможности.** Удаляем измеренные дубли и ненужный payload; не выкидываем языки, notices или protocol support ради красивого размера.
5. **Продвижение ведёт к удачному первому опыту.** Guide, фактическая установка, точные ограничения и обратная связь предшествуют широким claims. Нет фальшивых stars, массовых повторов submissions или скрытой telemetry.

## Связь с предыдущими ТЗ

| Источник | Как используется сейчас |
| --- | --- |
| [TZ-NEXT](../TZ-NEXT-2026-11.md), [TZ-PROGRESS](../TZ-PROGRESS.md), этапы Э0–Э8 | Существующие проверки, Direct+DPI, tuning, protocol imports, lists/cache/catalogue сохраняются. Пробелы live evidence переходят в NET/REL; подробный crosswalk — корпус 02 |
| [WN planning](../planning/WAARP-NEXT-2026-11-18/README.md) и исторический task-status | Карты/atlas/UX и принятый прежний код не ставятся заново с нуля. Новый backlog уточняет дальнейшие gaps |
| [V1](../V1.md) | Источник code acceptance, package design, языков и ограничений. Не заменяет runtime acceptance текущего SHA |
| [Android Chameleon](../ANDROID-CHAMELEON-2026-11-18.md) | Прямое основание STK; ADR фиксирует первый recovery slice и отдельный cross-app spike |
| [Android handoff #25](https://github.com/INNVoices/waarp/issues/25) | Сохраняется открытым до доказанного production candidate; новый parent #32 не закрывает его |
| [Companion bridge](../BRIDGE.md) | Существующий локальный продуктовый API; не система координации агентов и не произвольная «липучка» |

Старые инструкции о private visibility, WAIT_OWNER_START или docs-only skip-CI трактуются в их историческом контексте. Текущие разрешение пользователя и protected-main checks определяют нынешний workflow.

## Первые независимые назначения

Release agent ведёт диагностику REL и отдельный Windows evidence review. Routing/security agent может взять NET-001 или NET-004. UI/localization agent продолжает после слитого PR31: UX-002/003 и L10N-002. Build agent начинает BLD-001 без удаления файлов. Sticky agent получает ADR и bounded spike после merge карты. Distribution agent завершает guide, поддерживает receipts и проверяет следующий подходящий channel без повторных закрытых intake. Координатор сводит registry, ownership и evidence. Актуальные незанятые задачи печатает `ready`.

Завершение текущей сессии не создаёт бессрочную фоновую службу. Реально запущенные PR checks выполняются в GitHub; дальнейшие агенты получают эту карту, конкретные issues и сохранённые доказательства.
