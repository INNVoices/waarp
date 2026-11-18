# Выполнение подготовленного плана

**Статус: IN_PROGRESS.** 18 ноября 2026 года владелец явно разрешил начало сообщением «Иди работай» после завершения соседнего preview. Условие ожидания старта из исходного ТЗ выполнено. Актуальная очередь — [task-status.json](task-status.json).

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
