# Выполнение подготовленного плана

**Статус: первый реализованный срез функционально проверен; исходный план частично выполнен, полный выпуск заблокирован.** 18 ноября 2026 года владелец явно разрешил начало сообщением «Иди работай» после завершения соседнего preview. Условие ожидания старта из исходного ТЗ выполнено. Итог и точные границы — [09-ACCEPTANCE.md](09-ACCEPTANCE.md), актуальная очередь — [task-status.json](task-status.json). Записи ниже сохраняют хронологию, включая первоначальные ошибки и ожидания.

## Сверка WN-00

- Прочитан main `827a62bf6e9dfc45784a9ecfd50f5e1e72927924`, tree `dd9b813121d4dc4850b70636731588140874aa68`.
- Проверен опубликованный `preview-2026-11-18-r3`: его исходный код — `f66e5def3d689837db010c3453086a832c701fcc`, то есть исследованный код приложения.
- После подготовки изменились оформление, документация и галерея. Точки интеграции приложения и версии native core не изменились.
- В изолированном checkout сверены все 616 файлов и полное Git tree. Новых AGENTS.md на этом срезе нет. Незакоммиченная соседняя работа не переносилась.

## Текущая реализация

Работа разделена по владельцам: Windows диагностика/профили, Windows Atlas, Android интеграция и сетевой lifecycle/сквозная проверка. Общие JSON/API-файлы согласуются последовательно. Новых глобальных вкладок и второго сетевого scheduler нет.

Первый проверяемый native experiment — `test/continuity-native.check.ts`. Он использует реальные TCP/UDP через два локальных SOCKS endpoints и закреплённый desktop core. Проверяются обе настройки селектора, старые потоки и новый поток после подтверждённой смены. Тест не создаёт TUN, не меняет маршруты ОС и не обращается к публичным измерительным серверам.

Linux-артефакт получен из официального release и проверен по SHA-256 `43d61efe7e9fa3d833b0898b9dc1fa46a670fcbb79634e02f4b0d870037ea952`; `version` подтвердил `1.14.2-lx.11`, revision `3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d`. Выполнение native опыта в локальной среде **BLOCKED**: ядро не может создать системный netlink socket (`operation not permitted`). Это не PASS и не результат для Windows. Проверка добавлена в штатный Windows CI после получения и проверки закреплённого EXE.

Результаты остальных изменений и сквозных проверок будут внесены после интеграции. Незавершённый код не считается прошедшим приёмку; текущий опубликованный preview не переобъявляется новой сборкой.

## Интеграционный срез

### Контекстная проверка и назначение карточки

На обеих платформах добавлены `general`, `web`, `interactive`, `game`. Это назначение проверки, а не кнопка изменения транспорта приложения. Поле по умолчанию совместимо со старыми сохранениями и исключено из routing identity; одна смена назначения не меняет native graph.

Windows использует существующие diagnosis/checker/evidence: до четырёх путей по две HTTP(S)-проверки в прежнем бюджете, текущий личный путь имеет приоритет. Android использует существующий `repository.probe(url=...)`, до трёх путей по две проверки и только допустимые загруженные пути при ON. Подтверждения связаны с карточкой, целью, настройками, сетью и native session; отмена и смена контекста исключают позднее применение. Отвечающий текущий путь сохраняется. Альтернатива предлагается после двух завершённых отказов текущего и двух ответов альтернативы; отсутствие данных не считается отказом.

Windows применяет рекомендацию к существующей карточке через текущий apply path, без перемещения общего Auto. Android вносит её в draft и перепроверяет доказательство перед единственным «Сохранить». Для generic диагностики Windows сохраняется существующий сценарий адресной карточки. Системные DNS/TCP/TLS/HTTP проверки при включённом VPN больше не подписываются как доказанный Direct обход. Измерение HTTP не выдаётся за UDP, packet RTT, джиттер или пригодность игровой сессии.

### Локальная карта

MapLibre GL JS `6.19.0` и MapLibre Native OpenGL `13.7.1` используют общий локальный Natural Earth dataset. Источники, pins, лицензии и воспроизводимый генератор описаны в [ATLAS-DATA.md](../../ATLAS-DATA.md). 238 региональных anchors и 177 контуров обозначают регионы; точные позиции серверов и пользователя не вычисляются. Регион устройства задаётся вручную, неизвестные регионы остаются доступны в списке.

Windows: карта внутри существующих Connections и ServerPicker, общие фильтры/поиск/страницы, агрегация всего отфильтрованного каталога. Просмотр, подтверждённый active path и pending apply различаются. Android: карта внутри Tunnels и выбора подключения draft. Надпись «Выбран в форме» не означает native active path. Карта не запускает проверку или переключение. Список остаётся доступен при ошибке WebGL; карта и workers освобождаются при скрытии. Внешние тайлы, GeoIP backend и телеметрия карты не добавлены. Location/Wi-Fi permissions, приходящие из MapLibre manifest, исключены при merge; packaged APK verifier проверяет отсутствие этих разрешений и сохранение существующих network/service permissions. Реальные ELF из опубликованного MapLibre AAR проходят существующую проверку 16 KB для arm64 и x86_64; окончательная упаковка APK проверяется отдельно в CI. [Отчёт по опубликованному AAR](evidence/maplibre-native-review.json) фиксирует digest, API и ELF-проверки.

### Сохранение активного пути

Windows health round теперь использует существующий сериализованный owner изменений. Активный путь либо неизвестное состояние трафика удерживаются при необязательном улучшении и возврате с работающего резерва. Известный idle требует непрерывных свежих наблюдений и пяти секунд без потоков на пути. Это консервативный guard общего физического пути, не распознавание игровой сессии и не обещание переключения за пять секунд.

Подтверждённый отказ, удаление из разрешённой группы и явное изменение политики сохраняют приоритет. Команда OFF сразу инвалидирует фоновые результаты через generation; проверены гонки между двумя переключениями и поздний положительный ACK. Неполный `/connections`, неатрибутированные chains и ошибки разбора не становятся доказательством idle. Неизвестный путь не подписывается как Direct.

Production automatic selectors сохраняют `interrupt_exist_connections: true`. Значение `false` проверяется отдельно как способность закреплённого core в loopback experiment; оно не включено для произвольных пользовательских изменений. Удержание старых live-outbound workers после произвольной ручной смены не заявлено. Android использует уже имеющуюся консервативную session/unknown policy; второй scheduler не введён.

### Контрибуция

[CONNECTION-PROFILES.md](../../CONNECTION-PROFILES.md) описывает реальный небольшой PR: preset, назначение, допустимая цель проверки, fixture и необходимая проверка на обеих платформах. Неподдерживаемый manifest importer или plugin API не заявлен. Community backend остаётся отдельным WN-08.

## Выполненные локальные проверки

- `npm run typecheck` — PASS.
- `npm test` — 61/61 offline suites completed без ошибок; platform/native skips перечислены самим runner и не считаются native PASS.
- `npm run check` — PASS, 116 production modules reachable, 0 raw UI controls / literal UI strings.
- `npm run build` — PASS; MapLibre и география вынесены в lazy module/worker.
- `npm run test:performance` — PASS: 1 000 synthetic profiles, 201 routes, p95 compiler 4.00 ms при бюджете 500 ms. Это время компилятора конфигурации на текущей Linux машине, не время смены внешнего соединения.
- Android focused JVM: 26/26, реальные `ConnectionQualityTest`, `SelectionPolicyTest`, `MobileLiveRoutingTest` на Kotlin 2.2.21/JVM17.
- `npm audit --omit=dev --json` — 0 известных advisory в shipped JavaScript dependencies на этом срезе; это не заменяет отдельный audit build toolchain.
- `python3 scripts/android-instrument-test.py` — 10/10; пустые/частичные/упавшие instrumentation runs не проходят gate. Gallery теперь требует четыре сценария и пять кадров, включая настоящий local Atlas.

Локальный Chromium не дошёл до страницы: `socket() failed: Operation not permitted`. UI PASS и снимки локально не заявлены. Готовы обычные browser сценарии для Windows, отдельный file-origin worker smoke и Android Activity instrumentation. Полная Compose/native сборка и реальные кадры должны быть получены на штатных CI runners.

## Открытая приёмка

Первый native checkpoint run `44292266532` прошёл прежние Windows UI checks, но новый loopback тест остановился на таймауте. Статический разбор выявил неверное ожидание strict UDP: selector с interrupt закрывает всю старую SOCKS UDP association. Исправленная проверка должна подтвердить её закрытие и новый обмен через B; soft-проверка по-прежнему обязана сохранить старые TCP/UDP через A. На момент первого checkpoint native результат был незавершённым. Повторные реальные прогоны ниже подтвердили исправленный контракт.

В том же run upload-artifact отказал из-за заполненной GitHub storage quota. Ошибка загрузки не отменяет отдельно наблюдаемые результаты тестов. Небольшие synthetic UI captures и bounded native report сохраняются дополнительно в job log; existing upload/release gates не ослаблены. Существующий отдельный build-toolchain audit также остаётся красным до отдельного исправления зависимости; runtime audit оценивается отдельно.

### Наблюдения повторной приёмки

- `b2cc826`, run `44294130381`: прежний browser diagnosis-сценарий ошибочно ожидал повторное применение уже выбранного B. Исправлен fixture reset перед новым Check; проверки stale/no hidden retry/no mutation сохранены (`569d1a4`).
- Android `44294130127`: реальная компиляция обнаружила пропущенную скобку в Atlas projection. Исправлено в `0bfbb09`; дополнительный Kotlin PSI pass проверил 94 файла без синтаксических ошибок. Новый полноценный Android run — `44295048650`.
- Windows `44294900159`, job `134769283200`: **native continuity PASS** на настоящем pin. Soft сохраняет старые TCP/UDP через A, новые HTTP/UDP идут через B. Strict закрывает старые TCP и UDP association; новые соединения идут через B. ACK PUT+GET — 9.11/8.47 ms в loopback fixture. [Полный очищенный отчёт](evidence/windows-selector-continuity.json). Эти числа не являются WAN handover, Android AAR proof или измерением паузы игры.
- В том же Windows run production `file://` map реально загрузил local worker, GeoJSON и WebGL. Общий UI gate пока не завершён: рассчитываемый тестом JP click не учитывал автоматическое ограничение камеры MapLibre. Это отдельный helper defect; без успешного полного прогона UI PASS не заявляется.

Повторный native run на `0bfbb09` (`44295048679`, job `134769810226`) подтвердил оба сценария ещё раз: ACK 10.35/9.75 ms. Сохранённый `windows-selector-continuity.json` относится к этому повторному срезу.

### Приоритет явного изменения

В `6df55eba` закрыта подтверждённая гонка очереди: ранее после постановки `applyLive/start` в очередь health owner мог начать следующие фоновые selector PUT. Теперь синхронный `pendingExplicit` останавливает следующие автоматические действия до выполнения пользовательской команды. Уже отправленный PUT доводится до ACK и учитывается; его результат не теряется и не подменяется отменой. Read-only начальная проверка не откладывается на 15 секунд. Регрессии проверяют apply/start × fallback/group, освобождение barrier после ошибки/пропуска и возобновление automatic work.

Полный Windows UI gate прошёл на `93bff2a` (`44296118539`) и повторно на `6df55eba` (`44297055219`). Он включает local file-origin/CSP/worker, реальный canvas hit, выбор региона, 900 px, каталог целиком, paging/query, unknown, WebGL fallback, освобождение карты, scoped quality/cancel/stale и прежние UI сценарии. Итоговые native TUN и packaging результаты фиксируются отдельно после завершения заданий.

Android run `44295048650` (`0bfbb09`) прошёл полноценные Kotlin/JVM/lint/R8 build и APK integrity, включая merged manifest permissions и native 16 KB checks. Эмуляторная приёмка на этом этапе ещё выполняется; успешная сборка не является UI/render PASS.

### Замечания по включённым upstream материалам

Дополнены полные готовые notices MapLibre Native (Android и core), Gestures и MapLibre Java с точных source pins. Блоки скопированы целиком, Git blob SHA сверены с upstream; существующий APK verifier требует их присутствия. Для Java GeoJSON/Turf сохранены оба предоставленных upstream текста и записано расхождение POM/source metadata в [ATLAS-DATA.md](../../ATLAS-DATA.md). Новая генерационная подсистема для лицензий не введена.

Android `44295048650` завершил focused native TUN/feedback smoke и полную новую gallery (step26 SUCCESS); дальше отказала только доставка artifacts из-за GitHub quota. Точные JSON и пять исходных кадров извлекаются из job log для визуальной проверки. Исходники Android на этом срезе не содержат позднее добавленные полные license assets, поэтому окончательный packaging gate этих assets выполняется в следующем checkpoint.

Windows `44296118539` завершил все функциональные, native, 50-cycle, portable build и package-integrity steps. Общий job остаётся failure только из-за двух upload-artifact шагов; UI previews23 сохранены в логе. Код приоритета explicit intent из `6df55eba` проходит отдельный заключительный прогон `44297055219`.

### Визуальное исправление Android и общий результат повторных проверок

Второй Windows прогон `44297055219` на `6df55eba` завершил все product/UI/native/package steps. Сохранены [native loopback report](evidence/windows-selector-continuity-final.json), [все 50 TUN lifecycle PASS](evidence/windows-native-acceptance.txt) и [проверка portable пакета](evidence/windows-package.json). Soft/strict controller ACK в этом отдельном прогоне — 6.85/6.63 ms. Это только loopback PUT+GET; время паузы внешней сессии не измерялось. Доставка artifacts снова отказала по quota, нового опубликованного бинарного выпуска нет.

Android `44295048650` дал 200/200 JVM tests, 5/5 focused native/UI regressions и 4/4 gallery scenarios. Но просмотр исходного `05-atlas-local.png` выявил реальное перекрытие кнопки «Проверить» плавающей кнопкой импорта. Поэтому одного зелёного instrumentation результата недостаточно для визуальной приёмки. Подготовлен локальный fix: заголовок и проверка перед картой; в режиме карты 80 dp из прежнего нижнего резерва 104 dp вынесены из scroll content в границу viewport, внутри осталось 24 dp. Это освобождает и кнопку проверки, и нижние элементы карты в сохранённом и публичном каталогах.

Усиленный прежний gallery scenario требует шестой кадр при fontScale 1.5, проверяет геометрию видимых действий относительно FAB и выполняет настоящий tap по «Проверить» без предварительного скролла. Замер направлен на закрытый loopback port; проверяется обновление результата, неизменность revision и сохранение VPN OFF. При ошибке кадр снимается до восстановления fontScale. Шесть кадров обязательны в обычном и preview workflow. До нового emulator run это source/JVM проверенный fix, не runtime PASS.

### Общая выполняющаяся проверка для одинаковых запросов

Обе платформы теперь могут присоединить точный повтор к существующей операции. Windows сверяет target, route/purpose/profile signatures, runtime/revision и свежий fingerprint сети; изменённый запрос вытесняет предыдущий. Поздний fingerprint не вытесняет более новое намерение, неизвестная сеть не становится общим cache bucket, завершённый результат не заменяет новый явный Check. Отмена охватывает прежнего владельца и ожидающие результаты. Opaque native session token получает локальную scalar identity через WeakMap; циклический объект ChildProcess никогда не сериализуется в контекст.

Android присоединяет к существующему Deferred только полностью совпадающие target, draft, purpose и private ConnectionProofContext при отсутствии apply. Иной контекст сохраняет прежний busy-контракт до отмены/завершения владельца. Отмена присоединившегося ожидания не отменяет владельца; explicit cancel и закрытие исходного владельца продолжают отменять операцию. Сохранённые результаты повторно не используются.

Перед повторным CI прошли Windows typecheck и focused diagnosis-requests/diagnostic-owner/connection-quality/netmemory; новый тест проверяет ровно четыре настоящих Engine HTTP запроса для двух subscribers, один proof token, cancel/stale/out-of-order и cyclic native token. Android ConnectionCheckSharing + ConnectionQuality — 12/12 JVM, Kotlin PSI — 96 файлов без ошибок, instrumentation evidence runner — 10/10. Полная сборка и визуальная приёмка этого заключительного diff выполняются отдельным checkpoint.

### Checkpoint 2305781 и проверка воспроизводимости Windows snapshot timeout

Код, notices и руководство записаны в `main` как `230578139014639be497d10c30bd9da4d631cb28`, tree `d9a9b9b6a8d54d24833724bd5fe6b68efc761e41`; все 32 записанных файла и полное tree совпали с локальным проверенным срезом. Полные локальные typecheck/check/build и 62/62 offline suites прошли. Новые штатные прогоны: Windows/general `44300906714`, Android `44300906671`.

Первый Windows job `134790064653` на этом SHA прошёл UI, native selector и отдельную проверку сохранения процесса/соседнего TCP. Но 50-cycle gate остановился на 16-м цикле: 15/50 PASS, PowerShell snapshot timeout, elapsed 152464 ms из budget 600000. Packaging из-за этого не запускался. Этот результат не сводится к quota и не объявляется PASS.

Исходник локализует сообщение в `snapshot()` (`test/live.stress.ts`): пакет чтения NetAdapter/IPAddress/NetRoute/DNS и optional process-memory CIM, per-call limit 10 s. По сохранённому журналу нельзя определить конкретный cmdlet или отличить snapshot при ожидании ready от snapshot при ожидании removal. Исходный lifecycle JSON не попал в log; artifact upload отказал по quota. Успешный cleanup этого первого job не заявляется по generic runner cleanup.

Сам harness и его runtime-зависимости не менялись относительно предыдущих 50/50. Новый `index.ts`/`diagnosis.ts` в этот standalone executable не входят. Первые 15 циклов были примерно на 31.5% медленнее предыдущего runner по сумме start+stop; это наблюдение, не установленная причина сбоя. Штатным GitHub API запрошен один повтор выбранного Windows job на том же SHA, с теми же 50 циклами и deadlines: attempt 2, job `134795668292`. Gates и таймауты не изменены; результат повторной проверки фиксируется отдельно.

### Финальная приёмка 2305781 и завершение первого среза

Windows job `134795668292`, attempt 2 того же run `44300906714`, завершил renderer 31+4 Atlas+7 quality, 100 UI cycles, real-core selector, live route и **50/50 TUN lifecycle**. Lifecycle занял 428056 ms при неизменном budget 600000 ms. Portable EXE собран и проверен: 130518198 bytes, SHA-256 `b19f42adc911a9291b41081e90e9f42a3cdebd5dd154b5a9329ecfb52358c509`, packaged core соответствует pin. Этот успех не устанавливает причину первого snapshot timeout. Его журнал и derived report сохранены отдельно.

Android run `44300906671`, job `134790064761`: build/lint/R8/APK integrity/manifest/notices/16 KB compatibility gates, **204/204 JVM**, **5/5 native/feedback**, **4/4 gallery** прошли. Восемь native mutations использовали одну TUN/session. Эмулятор — Android 15/API35 x86_64 с 4096-byte страницами; это не runtime test на 16 KB устройстве. Исправленный map/FAB сценарий исполнен с fontScale1.5; настоящий touch обновил результат, сохранил revision/VPN OFF, затем маршрут сохранён единственной кнопкой.

Финальные нормальный и увеличенный Android кадры просмотрены вместе с Windows renderer. Карта и маркеры действительно отрисованы; кнопка «Проверить» доступна, FAB расположен вне scroll viewport. Осталось прежнее ограничение общей Android NavigationBar: при 150% подписи тесные, особенно «Диагностика». Полная accessibility/performance/physical-handover матрица не объявляется пройденной.

Оба final build jobs имеют overall FAILURE из-за `Artifact storage quota has been hit`; у Windows attempt 1 был также реальный lifecycle failure. Полные зависимые Android API matrix, optimized-release acceptance и двухчасовой soak пропущены из-за доставки artifacts. Runtime JS audit и полный audit toolchain различаются; имеющийся picomatch advisory остаётся документированным blocker. Release/tag и новые скачиваемые EXE/APK не публиковались, версии не повышались. Старый r3 не содержит новых функций.

Перед сохранением итоговых документов обнаружен входящий `main@abaa754eb3d14316bc594b960bc569d03355a1ef` с единственным изменением `test/payload.check.ts` — поиском OpenSSL из Git for Windows. Входящий файл сохранён без изменения; blob `22438517bf214e1851190c575191e8de0a90c1ce` и полное tree `2c02275073035ba258eca47f5402f9bc30932515` совпали. Продуктовый код принятого среза не изменился. Документация и изображения записываются поверх актуального main без перезаписи соседней работы.

Полный WN-план не закрыт: HTTP(S)-основа, Atlas и hold-policy приняты в указанном объёме; QoE/UDP, часть native capabilities, versioned method/source metadata, product drain и дополнительные UX/performance измерения остаются открытыми. Итоговая карта статусов и дальнейших границ — в [09-ACCEPTANCE.md](09-ACCEPTANCE.md). User guide, contributor path, отчёты и неизменённые screenshot evidence сохранены в Git.


## Завершение текущей интеграции: da5130c → 8482dfc

После команды владельца завершить недоделанное без нового функционала проверен актуальный `main@379f1b1`. Работа ограничена существующими картой, контекстной проверкой, формами и доставкой preview. Native core pins, транспортный стек и правила владения TUN не заменялись.

### Подтверждённые исправления

- **Windows Atlas.** Удалена задержка обновления значимых данных карты на 250 ms: выбранный регион, регион устройства и направления обновляются при изменении своих входных данных. Пока MapLibre worker обрабатывает предыдущий GeoJSON, следующее видимое состояние не теряется. Изменения только health-телеметрии не переотправляют неизменившуюся геометрию. Признак готовности кадра сбрасывается при обновлении данных и подтверждается событием `idle`; снимок после готовности относится к отображённым данным. Это исправление согласования UI, не замер FPS или обещание мгновенной внешней сети.
- **Текущий публичный путь карточки Windows.** Ранее отбор через `autoMembers` исключал даже выбранный публичный профиль, поэтому его результат оставался неизвестным. Теперь `diagnosisPaths` включает текущий `effective` путь первым, если VPN ON и профиль уже находится в фактическом `loadedProfileIds`. Другие публичные узлы не попадают в пул альтернатив; OFF не создаёт публичный checker. Из отбора и apply proof исключены отозванные и `subMissing` профили. Доказательство применения остаётся только для допустимой личной альтернативы, общий Auto не меняется.
- **Android, нижняя навигация.** Подпись ограничена собственной областью пункта, имеет одинаковую двухстрочную высоту и сохраняет полный текст для семантики. Устранён источник наложения соседних подписей при увеличенном шрифте; значки выравниваются по одной схеме. Общая структура навигации сохранена.
- **Android, регион устройства.** Подтверждена потеря значения при выходе условного `AtlasMap` из composition. Регион перенесён в общую локальную UI-настройку приложения: он сохраняется при «Список → Карта», выходе из формы и открытии другой формы. Позднее чтение сохранённого значения не заменяет более новый ручной выбор, включая очистку. Эта настройка не изменяет routing revision, VPN intent или native graph.
- **Android, длинное название региона.** В `AtlasMap.kt` строка действий «Вы: …» / «Все регионы» заменена на `FlowRow`: при недостаточной ширине кнопки могут перейти на следующую строку.
- **Windows, счётчик ответов диагностики.** В `src/renderer/src/pages/connection-quality.css` область `.quality-path-value` получила `min-width: min-content`, а её подпись `small` — `white-space: nowrap`. Короткая строка «ответов 2 из 2» сохраняется целиком; это исправление компоновки результата Windows, не прогресса Android-формы.

Первые исправления записаны как [`da5130cd4f6fe2a0a939a5633d1309370a4c30a6`](https://github.com/INNVoices/waarp/commit/da5130cd4f6fe2a0a939a5633d1309370a4c30a6). Потеря Android-региона и компоновка счётчика ответов Windows закрыты в кандидате [`8482dfcce4d554ee7448ea9d5c8810c6c3e38694`](https://github.com/INNVoices/waarp/commit/8482dfcce4d554ee7448ea9d5c8810c6c3e38694). На этом этапе код кандидата зафиксирован для приёмки r4. Два существующих focused suites `connection-quality` и `diagnosis-requests` прошли после исправления current-public; реальные локальные HTTP-запросы fixture адресовали явные `p-public-current`/`p-a` API tags. Они не являются внешним/native QoE доказательством.

### Сохранённый отказ renderer budget и UI-проверка кандидата 8482dfc

Общий Windows run [`44309773049`](https://github.com/INNVoices/waarp/actions/runs/44309773049), job `134820586582`, на `da5130c` прошёл четыре Atlas- и семь quality-сценариев, затем отказал на утверждении `100 renderer cycles exceed the predeclared 90 s budget`. Из retained log нельзя восстановить точное время измеряемого цикла, число завершённых итераций или per-cycle/memory metrics. Интервал между строками разных разделов включает подготовку и warm-up и не выдаётся за длительность 100 измеряемых циклов.

Этот stability-сценарий открывает новый renderer context с исходным видом списка и не открывает Atlas. Предшествующие Atlas checks, включая закрытие workers после возврата к списку, прошли. Доказательств утечки карты или установленной причины превышения budget нет. Отдельный preview того же `da5130c` прошёл свой UI gate; отказ общего run сохранён как failure, не списан на artifact quota.

На кандидате `8482dfc` оба Windows UI gates — [общий CI `44311748184`](https://github.com/INNVoices/waarp/actions/runs/44311748184) и [preview `44311748318`](https://github.com/INNVoices/waarp/actions/runs/44311748318) — прошли, включая 100 renderer cycles с тем же 90 s budget. Таймаут и критерий не увеличивались. Изменение Android-региона не объявляется причинным исправлением предыдущего Windows-сбоя; эти результаты устанавливают успешные прогоны этого среза.

### Привязка preview и предварительный native результат

Используется уже существующий выпуск напрямую в draft release, который не зависит от Actions artifact storage. Identity manifest обновлён на `preview-2026-11-18-r4`, Windows `0.4.1-rc.4`, Android `0.5.0-rc.5` / versionCode 6. Имена пакетов берут проверенные версии из prepare outputs. Требования Windows/native/UI/package и Android build/native/UI, полный набор EXE + три installable debug APK, checksums и точный source SHA сохранены. Это preview-процедура; она не объявляет полную stable/API matrix пройденной.

Native preflight проверки r4 `44311748318`, job `134827523837`, завершился PASS на точном checkout `8482dfc`: diagnostic CONNECT, TCP/UDP к выбранному новому пути, no-TUN UoT DNS и cleanup, сохранение main PID/TUN и соседнего потока, удаления и повторное добавление маршрутов. Prepare job `134828065854` также прошёл. Draft `449997174` перепривязан к `8482dfcce4d554ee7448ea9d5c8810c6c3e38694` при нулевом числе assets; старый исходный commit не смешивается с новой сборкой.

На момент этой записи preview ещё выполняется. Наличие draft и успешных отдельных gates не объявляется опубликованным выпуском. Итоговые статусы платформ, визуальная приёмка Android и фактическая ссылка скачивания отражаются в [09-ACCEPTANCE.md](09-ACCEPTANCE.md) после подтверждения результата.

## Повторная Android-приёмка: 8482dfc → 54a72e0 → 928c9a8

Последующая Android-проверка в [preview `44311748318`](https://github.com/INNVoices/waarp/actions/runs/44311748318) уточнила итог среза `8482dfc`: JVM — 204/204 PASS, native route/feedback — 5/5 PASS, UI gallery — 3/4, `passedGate: false`. Сценарий `atlasAndConnectionCheckKeepTheDraftUntilTheSingleSave` остановился при выборе региона: matcher `France` одновременно находил редактируемое поле поиска и строку страны. Retained failure содержит два разных semantics node, а не ошибку сохранения региона или native-маршрутизации. Этот run остаётся неуспешной UI-приёмкой; результаты остальных проверок не заменяют недошедший до конца сценарий.

В [`54a72e0655db697d7ba3a3ba351292857cf14bb8`](https://github.com/INNVoices/waarp/commit/54a72e0655db697d7ba3a3ba351292857cf14bb8) исправлена одна строка `MobileUiInstrumentedTest.kt`: `!hasSetTextAction()` исключает поле ввода из выбора строки региона. Проверяемый пользовательский сценарий и его утверждения сохранены. Release identity переведена на `preview-2026-11-18-r5` / revision 10. Этот промежуточный исходный срез заменён следующим до загрузки файлов: draft `450043418` наблюдался на `54a72e0` с пустым `assets`.

Отдельно просмотрен фактический `06-atlas-large-font.png` с `8482dfc`: при масштабе текста 150% подпись «Маршруты» оставляла одну «ы» на второй строке. В [`928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`](https://github.com/INNVoices/waarp/commit/928c9a8e3cd0a83a41ebfa15c2628ddb610ea157) добавлены три стандартных Compose-импорта и две строки стиля для подписей нижней навигации: `LineBreak.Heading`, `Hyphens.Auto`, `LocaleList("ru")`. Включён [стандартный механизм переноса Compose](https://developer.android.com/develop/ui/compose/text/style-paragraph), использующий правила и словари локали. Размер текста, отступы, доступная ширина и двухстрочный layout сохранены. Изменение адресует наблюдаемый PNG; итоговый кадр нового исходного среза ещё ожидается. Identity manifest получил revision 11 без изменения версий пакетов.

Новый [preview `44316534164`](https://github.com/INNVoices/waarp/actions/runs/44316534164) начал приёмку точного `928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`. Native preflight job `134844084052` завершился SUCCESS: retained checkout и все восемь `ROUTE_NATIVE … PASS` относятся к этому SHA. Prepare job `134844797736` также завершился SUCCESS; его лог в `2026-11-18T13:44:28Z` подтверждает подготовку r5 на этом же SHA. После prepare GitHub API подтвердил draft `450043418`: tag `preview-2026-11-18-r5`, точный target `928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`, `draft: true`, `prerelease: true`, `assets: []`, `published_at: null`. Таким образом, перепривязка с `54a72e0` произошла до загрузки пакетов. На момент этой записи платформенная приёмка и публикация нового среза ещё не заявляются завершёнными.


### Отдельный отказ общего UI-прогона на окончательном 928c9a8

Общий [Windows run 44316534397](https://github.com/INNVoices/waarp/actions/runs/44316534397), job `134844018930`, прошёл 4 Atlas- и 7 quality-сценариев, но затем превысил 90-секундный бюджет 100 renderer cycles в `test/ui.browser.mjs:357`. В сохранённом журнале нет точного измеренного elapsed, per-cycle metrics или итогового heap/DOM report; причина превышения не установлена. Нестабильность runner и утечка карты не доказаны. Сценарий использует новый Chromium context и in-memory IPC, без native/VPN/TUN и без открытия Atlas.

После UI failure по явным условиям всё же выполнились `engine:fetch` и `continuity-native.check.js`: soft PASS и strict PASS. Следующие route-native, 50 TUN и packaging gates пропущены. Позднейшие uploads отдельно отказали по artifact quota. [Статусы](evidence/928c9a8/general-windows-status.json) и [точные строки отказа](evidence/928c9a8/general-windows-failure.txt) сохранены; общий отказ не сводится к quota.

На том же `928c9a8` обязательный preview UI gate прошёл с прежними 100 циклами и бюджетом 90 s. Этот результат не отменяет failure общего run и не объявляется исправлением его причины. Конкретный preview workflow публикует после успешных jobs обеих платформ и точной проверки package/source/digest; conclusion отдельного general CI он не читает. Release policy и пороги не изменены. В итогах допустимо сообщить результат выпускного workflow, но нельзя утверждать, что все проверки всех workflows на этом SHA прошли.


### Итог выпуска r5

Preview [`44316534164`](https://github.com/INNVoices/waarp/actions/runs/44316534164) завершился SUCCESS во всех пяти jobs. Windows: UI/Atlas/quality, 100 cycles 80293.9800 ms при прежнем budget90000, native routes, 50/50 TUN 364040 ms и package/upload PASS. Android: build/APK integrity, 204 JVM, native5 и gallery4 PASS; финальные обычный/150% кадры просмотрены. Release `preview-2026-11-18-r5` опубликован как prerelease из `928c9a8e3cd0a83a41ebfa15c2628ddb610ea157` с девятью проверенными assets. Фактические снимки, отчёты и ссылки скачивания сохранены; [итоговая приёмка](09-ACCEPTANCE.md) заменяет прежнее состояние release-blocked для текущего preview. Полная stable-матрица и отдельный build-tool advisory остаются самостоятельными ограничениями.
