# 02. Маршрутизация, runtime-контракт и приватность

Срез: **21 ноября 2026, UTC**, main [`63fc7930abfeac1b870e9c8e3fabc500768f419e`](https://github.com/INNVoices/waarp/tree/63fc7930abfeac1b870e9c8e3fabc500768f419e). Корпус сохраняет существующую модель Waarp: правила приложения/сайта, личные профили, явные Direct/Block/Auto и ограниченный live apply. Новый компилятор, второй store, глобальный scheduler или альтернативный VPN runtime не требуются.

## Платформы, ownership и первая поставка

Владелец — networking/security-агент; для изменения обоих компиляторов назначается один ответственный за смысл и отдельный reviewer второй платформы. Windows: `src/shared`, `src/main/awg.ts`, `engine.ts`, routing/list/service helpers; Android: `data/RoutingCompiler.kt`, `MobileLiveRouting.kt`, `MobileRepository.kt`, `core/`, `service/`. UI-агент потребляет подтверждённое состояние и не создаёт второй путь применения. REL-владелец отвечает за подпись/бинарники/CI; vendor cleanup не входит в этот корпус.

**Первый полезный PR — NET-001:** небольшой общий набор смысловых примеров для двух существующих компиляторов и карта уже выполненных проверок. Новые tests добавляются только для реально отсутствующего перехода или намеренно отличающегося поведения. Если проверка уже существует — ссылка и `ALREADY_DONE`, не её копия. NET-004 может выполняться параллельно как адресная проверка границ секретов.

**Scope:** сохранить точный смысл правил и DNS, подтверждение фактического runtime, корректность ошибок/rollback, границы сетевого доступа и конфиденциальности. **Non-goals:** обещание обхода блокировок в любой стране, новый публичный VPN-сервис, автоматическая отправка личных конфигураций, массовое сканирование чужих узлов, новые transport features без тестового сервера, переписывание core и подмена отсутствующей native-проверки парсером. В текущем аудите новая security vulnerability или подтверждённый product routing bug **не установлены**; ниже различаются evidence gaps и запланированные расширения.

## Что уже реализовано и что не следует перепланировать

| Существующая возможность | Код/проверки | Статус и точная граница |
| --- | --- | --- |
| Desktop live slot apply, affected-route barrier, per-file witness и rollback | `src/main/engine.ts`, `live-routing.ts`, `test/slots.check.ts`, `route-switch-matrix.check.ts` | `EXISTING`. `closeTouched` уже сравнивает effective owner; DELETE считается успешным только при `r.ok` и прежней runtime generation. Старые замечания Э0.2 нельзя снова объявить открытым дефектом без воспроизведения. |
| Android live configuration transaction | `data/MobileRepository.kt`, `MobileLiveRouting.kt`, `core/LiveRoutingFiles.kt`, `RoutingWitness.kt`, `VpnController.kt`; соответствующие JVM tests | `EXISTING`. Подготовка, native ACK, encrypted persistence, rollback и uncertain-routing state уже имеют владельца. Не заменять это stop/start на любую ошибку. |
| DNS и fail-closed compile | `src/main/awg.ts`, `test/routing-dns-priority.check.ts`; Android `RoutingCompiler.kt`/`systemDnsPolicy()`, `SystemDnsPolicyTest.kt` | `EXISTING`. Нужна согласованная карта обеих платформ; один TS suite не доказывает Android semantics и наоборот. |
| Bounded диагностика/Auto hold | `src/shared/connection-quality.ts`, `src/main/diagnosis.ts`, `engine.ts`; Android `ConnectionQuality.kt`, `VpnController.kt` | `EXISTING`. Unknown telemetry не считается idle. HTTP availability/latency не равны QoE, UDP delivery или доказанному маршруту приложения. Частичные WN-04/05 сохраняются. |
| Хранение секретов | Windows `store.ts`: DPAPI/safeStorage, нет plaintext write fallback; Android `ProfileStore.kt`: AndroidKeyStore AES-GCM, AtomicFile, сохранение повреждённого store | `EXISTING`. Это проверенная реализация, не аудит всех возможных sink. Android `allowBackup=false`, VPN service/receiver не экспортированы. |
| Совместимость импорта | Windows `awg.ts`, `links.ts`, `vless.ts`; Android `ProfileImporter.kt`, `OpenVpnImporter.kt`, `MasqueImporter.kt` | `EXISTING/PARTIAL`. Desktop AWG3 fields и scoped `tls_record_fragment` уже есть; Hysteria2 port hopping разбирается обеими платформами. Android AWG3 parity и end-to-end interop всех форматов не установлены данным аудитом. |
| Локальный Atlas и контекстная проверка | [WN status](../planning/WAARP-NEXT-2026-11-18/task-status.json) и существующие UI/data files | Завершённый scoped preview сохраняется; Community Atlas, полный QoE, physical handover и production soft drain не объявляются уже сделанными. |

Историческая привязка: [Э0–Э8](../TZ-NEXT-2026-11.md) остаются исходными этапами. Э0/Э1/Э5 уже получили значительную реализацию и tests; NET-001/002 сверяют смысл и оставшуюся приёмку. Э2 не начинается с пустой кнопки: desktop fragment rules уже в `awg.ts`; NET-003 описывает поддержку и runtime-предел. Э4 AWG/HY2 включает реализованные импорты; проверяются только незакрытые interop/validation случаи. Э6–Э8 опираются на действующие catalogs/lists/cache/policies; NET-005 не создаёт второй updater. [WN-01/04/05](../planning/WAARP-NEXT-2026-11-18/09-ACCEPTANCE.md) остаются частичными в объявленных физических/native/QoE измерениях.

Свежие [Android результаты 44831610512](https://github.com/INNVoices/waarp/actions/runs/44831610512) содержат отказы **до** runtime tests на API 29/36. Эти отказы принадлежат REL-001/002/003; они не доказывают DNS leak, неверный маршрут или crash приложения. Новые conclusions о продукте требуют достижения соответствующей стадии теста.

## Волны и обязательные инварианты

1. **Контракт и границы:** NET-001 + NET-004. Инвентаризировать существующее, добавить только отсутствующее доказательство/узкое исправление.
2. **Native применение:** NET-002; параллельно NET-003 и NET-005. Использовать текущие controlled fixtures и pinned engines.
3. **Физическая сеть:** NET-006 после доступного signed candidate и устройства. Результаты привязаны к фактической сети/OS/профилю, не ко всем пользователям.

Общие инварианты: выбранное/сохранённое/применённое/проверенное — разные состояния; OFF/revoke сильнее позднего callback; отсутствующий профиль не превращается в тихий Direct; explicit Direct остаётся выбором пользователя; публичный путь не выбирается скрыто; DNS и новый TCP/UDP поток следуют задекларированному правилу; telemetry unknown не разрешает разорвать чужую сессию; identity/runtime generation не переиспользуется после замены core.

### NET-001

**Title:** Согласовать проверяемый смысл правил и DNS на двух платформах

- **Priority:** P0.
- **Status:** `ready`: компиляторы и отдельные tests уже существуют; общий подтверждённый контракт для текущих двух engines ещё не оформлен. Нового дефекта пока нет.
- **Dependencies:** нет.
- **Files:** `src/main/awg.ts`, `src/shared/types.ts`, `src/shared/routing-edit.ts`, `test/routing-dns-priority.check.ts`, `test/route-switch-matrix.check.ts`; Android `data/RoutingCompiler.kt`/`systemDnsPolicy()`, `MobileLiveRouting.kt`, соответствующие JVM tests. Малые neutral fixtures можно добавить в существующее test-data дерево после выбора обоих потребителей.
- **Change:** описать максимум 12–16 канонических случаев: app против domain, overlap/order одного kind, suffix против exact/IP/CIDR, Direct/Block, отсутствующий/revoked профиль, fallback, default route, shared/system DNS, IPv6 при неподдерживающем endpoint, LAN/self bypass и disabled route. Для каждого записать expected route/DNS/block и намеренные различия платформ. Сначала сопоставить уже имеющиеся assertions; добавить consumers только там, где это действительно предотвращает рассинхронизацию.
- **Acceptance:** оба компилятора дают ожидаемый смысл при разных JSON shapes/native versions. Не требовать byte equality несопоставимых config; не использовать только самописный evaluator как доказательство реального ядра. Противоречие классифицировано: deliberate platform difference, importer gap, real regression или unsupported. Для найденной ошибки есть минимальный воспроизводимый fixture, правка существующего owner и отрицательный случай. Зафиксирован порядок app/domain rules, а визуальное перемещение между kinds не обещает изменения этого порядка.
- **Verification:** один запуск затронутых TS checks и targeted Android JVM classes. `sing-box check`/libbox validation — только доступный фактический binary с pin/hash, иначе `NOT_RUN`. Полная emulator-матрица не нужна для одной fixture/documentation правки. Перед production новое compile-поведение проходит адресный native сценарий NET-002.

### NET-002

**Title:** Закрыть недостающую native-приёмку live apply и rollback

- **Priority:** P0.
- **Status:** `planned`: live/rollback реализованы и покрыты тестами; недостающие сочетания и текущий native evidence уточняются до изменения кода.
- **Dependencies:** NET-001.
- **Files:** `src/main/engine.ts`, `live-routing.ts`, `live-outbound.ts`, `test/slots.check.ts`, `test/live-outbound-races.check.ts`, `test/route-lifecycle.check.ts`, native route fixtures; Android `MobileRepository.kt`, `LibboxRuntime.kt`, `LiveRoutingFiles.kt`, `RoutingWitness.kt`, `VpnControlLane.kt`, `VpnLifecycleInstrumentedTest.kt`.
- **Change:** построить небольшую таблицу уже проверенных переходов: Direct→личный→другой путь, последний/неактивный route delete, перекрывающий reorder, group selection, отказ одной rule-file записи/ACK, failure persistence после native ACK и поздний OFF/revoke. Один непокрытый переход — один узкий PR. Reuse текущий per-file witness и transaction owner; не добавлять параллельную apply state machine.
- **Acceptance:** на совместимом live apply PID/core/TUN identity сохраняются; новый контролируемый поток идёт ожидаемым путём. Соседний поток не закрывается из-за изменения другой карточки. На ошибке подтверждён rollback либо guard остаётся на затронутом наборе; UI не сообщает сохранённый выбор как applied. Failed/late DELETE не считается закрытым соединением. Правка не оживляет OFF/revoked и не перезапускает runtime для маскировки неполного ACK. Если native capability не поддерживает soft drain, это явно `UNSUPPORTED/NOT_VERIFIED`; не обещать безразрывность текущих TCP/UDP сессий по успеху selector API.
- **Verification:** offline injection только отсутствующей стадии отказа; затем один controlled native TCP+UDP сценарий затронутой платформы с собственными fixtures, real peer counters и before/after identity. Linux assertions не считаются Windows TUN; x86 emulator не считается physical mobile handover. Текущие Android инфраструктурные блокеры решаются REL, durations/лимиты не растут ради pass.

### NET-003

**Title:** Разделить поддержку импорта, native config и реальный interop

- **Priority:** P1.
- **Status:** `planned`: широкий import support имеется; полная current per-platform interop-матрица не установлена.
- **Dependencies:** NET-001.
- **Files:** `src/main/awg.ts`, `vless.ts`, `links.ts`, `openvpn.ts`, `techview.ts`, import tests; Android `data/ProfileImporter.kt`, `OpenVpnImporter.kt`, `MasqueImporter.kt`, `ProfileTuning.kt`, importer tests; claims в `README.md`, `README.ru.md`, `docs/INSTALL.md` меняет владелец документации после согласованной матрицы.
- **Change:** для каждого реально импортируемого protocol/transport указать четыре независимых уровня: import/persist round trip, compiled native field, pinned-engine config check, controlled end-to-end transport proof. Отдельно version/platform/option и дата. Начать с уже рекламируемого набора, AWG variants, VLESS transports/REALITY, HY2 hopping, OpenVPN и MASQUE только там, где они реально есть. Не писать поддержку по одному имени в generic outbound JSON.
- **Acceptance:** `pqv` не назван работающим: desktop сохраняет `notApplied`, Android TLS importer его отклоняет. Hysteria2 диапазоны не разбираются как одиночный порт; неверные key/range/options fail predictably. Desktop AWG3 parsing не превращается в заявление Android AWG3 compatibility; наличие `header_protection_key` не подменяет серверный interop. XHTTP extra/unsupported параметры не исчезают молча. Для каждого реального сетевого pass записаны pinned engine, обезличенная server fixture, проверенные TCP/UDP/DNS свойства; public catalogue success не доказывает доверие к узлу. Без своего/разрешённого тестового сервера — `NOT_RUN`, без изобретённого pass.
- **Verification:** существующие importer fixtures + одна негативная fixture на конкретную исправляемую опцию. Конфиг-проверка без сети отдельно от максимум одного controlled interop run для изменённого protocol path. Не проверять все публичные endpoints и не запускать несколько engines с одинаковыми активными WireGuard/AWG credentials.

### NET-004

**Title:** Проверить конкретные границы секретов и входов приложения

- **Priority:** P0.
- **Status:** `ready`: DPAPI/Keystore/atomic writes, redaction и ограниченные entry points уже есть. Непрерывное доказательство пути secret→sink для текущего exported diagnostics ещё нужно; подтверждённой утечки этим аудитом не найдено.
- **Dependencies:** нет.
- **Files:** Windows `src/main/store.ts`, `store-core.ts`, `private-file.ts`, `techview.ts`, IPC/preload и diagnostics/export owners; Android `data/ProfileStore.kt`, `Models.kt`, `LastSessionEvidence.kt`, `MainActivity.kt`, `core/LibboxRuntime.kt`, `AndroidManifest.xml`, `res/xml/file_paths.xml`, `data_extraction_rules.xml`, external-import tests.
- **Change:** составить компактную карту secret classes и реальных sinks: private/pre-shared/header-protection keys, password/UUID, signed subscription URL/query, controller secret, raw config, exporter/clipboard/native crash/error/log. Прогнать синтетические уникальные canaries через обычный import/persist/UI/error/diagnostic export; явное «скопировать подключение» проверять отдельно как намеренный secret export. Проверить отсутствие plaintext fallback и сохранение исходного файла при missing key/DPAPI/atomic-write error. Проверить реальные IPC/deep-link/import entry points на validation, отсутствие автоматического ON и обхода подтверждённого пути пользователя.
- **Acceptance:** обезличенный отчёт не содержит canary или его очевидного URL/base64 представления; личный ключ не появляется в экранном DTO/toString/log/CI artifact. Secret-bearing export остаётся явным отдельным действием. Шифрование, случайный nonce, native temp cleanup и no-backup policy не ослаблены. Ошибка расшифровки не уничтожает store. Android non-exported service/receiver и ограниченный FileProvider сохраняются; renderer/web entry не получает произвольный file/process/native command доступ. Конкретный дефект оформляется только после воспроизведения; отсутствие finding не называется полным security audit.
- **Verification:** не читать реальные пользовательские secrets/keystore. Одна bounded synthetic fixture на реальный sink/ошибку, существующие impacted tests; для platform storage один smoke на целевой OS при доступности. Не публиковать dump секретов как тестовый артефакт. Расширять аудит на новый модуль только по обнаруженному data flow.

### NET-005

**Title:** Зафиксировать offline/cache/revocation и политику служебного трафика

- **Priority:** P1.
- **Status:** `planned`: каталоги, bounded HTTP/DNS и policy separation уже реализованы; для текущего кандидата нужна короткая объединённая failure matrix.
- **Dependencies:** NET-004.
- **Files:** `src/main/catalog.ts`, `catalog-endpoint.ts`, `service-transport.ts`, `proxy-http.ts`, `vless.ts`, `lists.ts`; `test/service-download.check.ts`, `public-service-path.check.ts`, `public-service-transport.check.ts`; Android `NetworkTools.kt`, `PublicCatalog.kt`, `PublicSourcePolicy.kt`, `ProfileStore.kt`, `NetworkOperationTest.kt`, `HttpCancellationTest.kt`; [Android HTTP security contract](../ANDROID-HTTP-SECURITY.md).
- **Change:** reuse существующие policy/cache механизмы. Сверить offline start с последним валидным state, damaged/oversized/slow/decompressed response, redirect, cancellation, revoked/subscription-missing profile, refresh после смены сети. Показать пользователю источник/возраст/ошибку без предположения «страна измерена» или «узел безопасен». Новые mirrors/signatures/автономный updater не входят в эту поставку; это будущая отдельно спроектированная Э7 с определённым издателем и ключом.
- **Acceptance:** отказ GitHub/каталога/probe-host не стирает личные профили и последнюю валидную snapshot; partial parse не публикуется как complete list. Public catalogue allowlist/SSRF/redirect limits не расширяются на private subscription URLs. Private credentials не уходят на новый публичный маршрут; serviceVia и bypass остаются явными. Отмена/deadline не оставляют probe/core workers; устаревший ответ не возрождает revoked state. Точный duplicate effective config может объединяться, разные transport/path/SNI не теряются.
- **Verification:** existing local socket/fake network tests с одной targeted regression на отсутствующий случай. Максимум один offline-start smoke с уже импортированным synthetic profile; не делать массовых реальных downloads. Signed mirror/update infrastructure не добавлять как побочный эффект этой задачи.

### NET-006

**Title:** Измерить физический handover, DNS и lifecycle без выдуманной универсальности

- **Priority:** P1.
- **Status:** `blocked`: нужен accepted signed candidate и доступное согласованное физическое устройство/сеть. Historical emulator screen-off/Doze не является такой приёмкой.
- **Dependencies:** NET-002, REL-006.
- **Files:** `service/WaarpVpnService.kt`, `VpnRecoveryWatchdog.kt`, `core/VpnController.kt`, Android network observer/runtime owners; существующие acceptance scenarios и отдельный обезличенный physical record. Windows route/native evidence использовать отдельно, если сценарий переносится.
- **Change:** подготовить и выполнить короткую заранее фиксированную матрицу: Wi-Fi→cellular→Wi-Fi, короткая потеря сети, same-interface address change, process death с сохранённым ON, явный OFF/revoke, screen-off/Doze. Наблюдать реальные DNS egress/traffic и временной разрыв собственного тестового потока; разделить transport recovery, UI readiness и успешный новый запрос. Не обещать отсутствие разрыва существующей TCP-сессии при смене внешнего IP.
- **Acceptance:** record содержит device/OS/ABI/page size, candidate hash, network type, timestamps/peer counters, state/generation и ограничения наблюдения. Старый callback не включает выключенный VPN. Unknown network/telemetry не выдаётся за успешную проверку; исключения LAN/service DNS соответствуют выбранной политике, не скрываются общим словом «leak-free». 30 s alarm target и emulator recovery gate не обещают точного срока на физическом устройстве/в Doze. При неудаче сохраняется evidence и воспроизводимая задача, а не увеличение deadline до pass.
- **Verification:** один bounded сценарий на устройство/сеть после REL-006, без многосуточного burn-in по умолчанию. Использовать собственный controlled endpoint, не записывать SSID/IP/ключи пользователя в публичный отчёт. При отсутствии доступа готовый сценарий и collector — полезный результат; сам physical acceptance остаётся `NOT_RUN`.

## Правила сдачи

Каждый агент сдаёт один смысловой diff с task ID, входным commit, exact touched paths, PASS/FAIL/NOT_RUN и ссылками на существующее/новое evidence. Сначала показать воспроизводимый разрыв контракта; затем исправлять владельца. Не рефакторить соседний UI/слои только ради симметрии, не менять пакетное имя, signing pin, ресурсные budgets или источник данных без относящегося к задаче основания. Completed historical Э/WN сохраняются, а новый proof связывается с собственным commit и средой.
