# 01. Production release: доказательства, подпись и публикация

Срез: **21 ноября 2026, UTC**, исходный main [`63fc7930abfeac1b870e9c8e3fabc500768f419e`](https://github.com/INNVoices/waarp/tree/63fc7930abfeac1b870e9c8e3fabc500768f419e). Это исполнимое ТЗ для следующего кандидата, а не сертификат готовности текущих бинарников. После изменения исходников новый исполнитель сначала сверяет HEAD и открытые PR; старое зелёное свидетельство не переносится автоматически.

## Платформы, владелец и границы

Владелец корпуса — release/CI-агент. Платформы: Windows 10/11 x64 и Android API 29+ с тремя заявленными ABI. Android runtime CI использует x86_64; статическая проверка ARM не заменяет запуск на ARM-устройстве. Приватный production-ключ принадлежит существующей процедуре владельца/доверенной среды подписи; агент готовит входы и проверяет выходы, не создаёт новый ключ и не заменяет сертификат. Изменения компиляторов маршрутизации принадлежат [корпусу 02](02-routing-and-security.md), интерфейс и sticky-интеграция — своим корпусам.

**Scope:** убрать конкретные слепые зоны CI; получить полный результат одного кандидата; связать исходники, артефакты, runtime и подпись; проверить установку и передачу в публикацию. **Non-goals:** новая транспортная архитектура, уменьшение длительности soak, выключение проверок tracing/страниц/подписи, автоматическое удаление чужих процессов/адаптеров, новый signing identity, изменение версий ради зелёного статуса, обещание принятия сторонним каталогом. Vendor/dependency-переработка ведётся отдельно.

Первый диагностический PR этой карты — **REL-001** (уже слит): сохранить bounded read-only сведения об Android framework при отказе установки до teardown. Он не исправляет предполагаемую причину `Broken pipe` и не объявляет APK прошедшим приёмку.

## Проверенная исходная точка

| Область | Статус на срезе | Что именно подтверждено |
| --- | --- | --- |
| Общий CI main | `DONE`, в своей области | [44831610520](https://github.com/INNVoices/waarp/actions/runs/44831610520): dependency audit, Windows checks, Linux AWG protocol/crash — success. Это не результат полной Android-матрицы. |
| Полный Android main | `FAIL`, причина нескольких стадий различается | [44831610512](https://github.com/INNVoices/waarp/actions/runs/44831610512): build/static/unit/lint, native API 29/35 и release API 35 — success; native API 36, release API 29/36 — failure; 2h soak — skipped. |
| Native API 36 | `OBSERVED_FAILURE`, причина `UNKNOWN` | [job 136621297650](https://github.com/INNVoices/waarp/actions/runs/44831610512/job/136621297650): первый debug APK не установился, `Failure calling service package: Broken pipe (32)`. Это сбой до тестирования VPN; журнал после завершения эмулятора не объясняет причину исчезновения Binder-сервиса. |
| Release API 29 | `OBSERVED_FAILURE`, причина `UNKNOWN` | [job 136621297539](https://github.com/INNVoices/waarp/actions/runs/44831610512/job/136621297539): подготовка отклоняет изменение новых framework PID во время ожидания Binder. В том же логе есть `service settings: Broken pipe`; не переименовывать это в дефект маршрутизации. |
| Release API 36 tracing | `OBSERVED_FAILURE`, владелец события `UNKNOWN` | До установки приложения guard отклоняет `eventsEnabled=X`. В [PR29 run 44829589582](https://github.com/INNVoices/waarp/actions/runs/44829589582/job/136616804337) артефакт `14677535202` сохранил точное `bpf_trace:bpf_trace_printk`; исходный отказ и отсутствие tracefs mutations сохранены. |
| Публичные бинарники | `EXISTING_PREVIEW` | [r6 Windows 0.4.1-rc.5](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r6), [r5 Android 0.5.0-rc.5 debug](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r5). Source `1.0.0` не является опубликованным production APK. |
| Статическая сборка и подпись | `EXISTING` | `android-build.mjs`, `android-verify.py`, `android-sign.py`, `android/native-source.json`, `android/release-signing.json`: три unsigned ABI, проверка native/manifest/16 KiB, сохранённый pin сертификата, доказательство неизменности ZIP payload при подписи. |
| Связность release evidence | `DONE`, ограниченный контракт | [PR28](https://github.com/INNVoices/waarp/pull/28), `android-release-readiness.py`, [описание bundle](../ANDROID_RELEASE_EVIDENCE.md): exact source, один полный run/attempt, архивы с digest/receipt, raw runtime validation, unsigned→signed binding. Это offline consistency, не самостоятельная аутентификация CI receipts и не разрешение публикации. |

Уже выполненные [V1 code acceptance](../V1.md), [Э0–Э8](../TZ-NEXT-2026-11.md) и [WN-00…08](../planning/WAARP-NEXT-2026-11-18/task-status.json) сохраняются как история своего среза. Они не обнуляются новым планом. Исторические ограничения доставки Actions artifacts не заменяют свежую причину текущих failures.

## Исторический срез перед runtime wave 21 ноября

Исходный main этого исторического среза — `217870599b3ab1913f68bade5bebf8eb44b192f8`.
Его [общий CI 44859115697](https://github.com/INNVoices/waarp/actions/runs/44859115697)
прошёл Windows checks, оба dependency audits и Linux AWG protocol/crash. Независимо
скачан validation artifact `14689192296`: ZIP size/digest/CRC совпадают, четыре
внутренних JSON проверены по байтам. [Сохранённый record](evidence/2026-11-21-windows-217.json)
связывает source/run/jobs/artifacts: 50/50 native TUN lifecycle cycles, soft/strict
TCP/UDP selector semantics и готовый portable package. EXE hash из проверенного
CI report: `6bc77280f61b22f214353b674f71ac3773d7a4c6a694ef76bfeeb49f81378b8e`.
Сам portable ZIP в этом baseline review отдельно не скачивался. Эти сценарии не
закрывают реальный UAC, portable upgrade с профилем, физический sleep и другой VPN.

На этом историческом срезе [Android run 44857532546](https://github.com/INNVoices/waarp/actions/runs/44857532546)
принадлежит более раннему `35c3b2e11d0001f482dbae22abccbed4db8769bf`: build,
native29/native35/release35 — success; release29/native36/release36 — failure;
soak — skipped. Этот результат не переносится на main217.

[API29 causal record](evidence/2026-11-21-api29-binder.json) сопоставляет старый
Binder owner и новый system_server в kernel logs. Предложенный barrier дополняет
исчезновение PID строгим отсутствием activity/package/display registrations
перед единственным start, в прежнем stop deadline. Display startup path основан
на exact AOSP source; конкретный сервис fatal transaction по скрытому Java stack
не доказан. 38 preparation и 10 installer regression tests прошли; на том этапе ожидался новый emulator
run. Результат PR #42 сохранён в следующем разделе.

[Host AVD receipt](../ANDROID-AVD-RECEIPT.md) собирается на API36 до guest tests и
отдельно после teardown. Он читает только allowlisted SDK/AVD metadata и параметры
собственного emulator process, не меняет конфигурацию. Частичный diagnostic receipt
остаётся частичным и не останавливает или заменяет настоящие runtime gates.
На том этапе graphics hypothesis и независимый ftrace blocker ещё требовали новых данных. Результаты PR #44 и PR #45 ниже не объединяются в общий pass.

## Новое наблюдение после baseline: PR30

[PR30](https://github.com/INNVoices/waarp/pull/30) слит как `35c3b2e11d0001f482dbae22abccbed4db8769bf` после успешного общего CI. Его [native API36 job](https://github.com/INNVoices/waarp/actions/runs/44856329155/job/136701575165) впервые сохранил install failure bundle: package/settings отсутствуют; до неудачной установки трижды падает системный SurfaceFlinger, `RegionSampling`, assertion в `GoldfishMapper::readFromHost`. Collector завершился за 0.524 s; исходный отказ не изменён, CRC ZIP и 22 raw hashes/bytes проверены независимо. [Сохранённый derived record](evidence/2026-11-21-pr30-install.json) содержит source/job/artifact binding и пределы вывода.

Это новое свидетельство графического/framework отказа гостя, а не доказанная полная первопричина feature mismatch и не Android acceptance. Следующий read-only шаг — сопоставить точную emulator/image/graphics конфигурацию с этой assertion; не отключать UI, `RegionSampling`, tracing или проверки ради pass. Другие неуспешные jobs имеют собственные причины и требуют отдельного разбора.

## Продолжение 21 ноября: принятые исправления и оставшийся отказ

Исходная точка этой сверки — main `202c70125daf94bb8499c3b758420cd9ce90a52f`, после PR #42/#43/#44. Ни один результат в таблице не назван новой полной приёмкой main.

| Область | Проверенное свидетельство | Вывод и граница |
| --- | --- | --- |
| REL-002, API 29 | [PR #42](https://github.com/INNVoices/waarp/pull/42), [run 44862192000](https://github.com/INNVoices/waarp/actions/runs/44862192000), [оригинальный accepted record](evidence/2026-11-21-api29-accepted.json) | Barrier дождался исчезновения activity/package/display перед единственным start; native 26/26 и release journey прошли. Закрыто исследование конкретного stale-Binder отказа; частота стабильности не измерялась. |
| REL-009, API 36 AVD | [PR #44](https://github.com/INNVoices/waarp/pull/44), [run 44864148533](https://github.com/INNVoices/waarp/actions/runs/44864148533), [SDK 20 record](evidence/2026-11-21-api36-sdk20-accepted.json) | Штатное создание AVD через cmdline-tools 20.0 дало target android-36.1 вместо android-0 на прежнем image/backend; native 26/26. Отдельный trace guard продолжил отказывать. |
| REL-007, Windows portable | [PR #43](https://github.com/INNVoices/waarp/pull/43), [run 44863162870](https://github.com/INNVoices/waarp/actions/runs/44863162870), [portable record](evidence/2026-11-21-windows-portable-pr43.json) | Три запуска настоящего EXE за 46.570 s: import, normal exit, restart и остановленная замена тем же candidate. Профиль сохранён, owned processes завершились. UAC, смена версии, rollback и физические сценарии остаются NOT_RUN. |
| REL-007, новый Windows candidate | [PR #47](https://github.com/INNVoices/waarp/pull/47), [run 44940260860](https://github.com/INNVoices/waarp/actions/runs/44940260860), [проверенный validation receipt](evidence/2026-11-21-windows-cleanup-pr47.json) | Три запуска EXE за 49.745 s и девять SVG прошли; profile/settings/master OFF и normal exit/cleanup сохранены. Отдельный native lifecycle — 50/50. Новый EXE локально не скачивался; его измерения и hashes связаны с actual CI lifecycle. Merge ожидает подтверждения владельца. |
| REL-003, отдельный preflight | [run 44882755101](https://github.com/INNVoices/waarp/actions/runs/44882755101), ec71e72 / PR merge 8266058a | Trace preparation прошла: 307 таблиц, 614 завершённых iterator streams, GLOBAL, свежие нулевые counters и один 4→16 KiB write/readback. Это подтверждение подготовки tracefs, без APK journey или soak. |
| REL-003/004, полный Android | [run 44882755131](https://github.com/INNVoices/waarp/actions/runs/44882755131), тот же ec71e72 / PR merge 8266058a | 6 success, 1 failure, 1 skipped. Optimized API 36 отказал в `task_inventory_middle`: `known_thread_missing`, `missing_positive_shared_member`, 0.626 s. Второй descriptor pass, GLOBAL, resize и приложение не достигнуты; 7 200 s soak пропущен. |
| REL-003/004, main-based PR #48 | [run 44940333222 / job 136958307750](https://github.com/INNVoices/waarp/actions/runs/44940333222/job/136958307750), head 53b0206 / PR merge ba9497f9 | 6 success, 1 failure, 1 skipped. Прежний main guard отказал на `eventsEnabled=X` / `bpf_trace_printk` до mutation и APK install; 7 200 s soak skipped. Advanced observer PR #45 здесь отсутствует. Native API 29/35/36 и release API 29/35 прошли; общий CI отдельно успешен. |

[Повторная проверка исходных ZIP и raw receipts](evidence/2026-11-21-ec71-acceptance-recheck.json) сохранила оба исхода отдельно. У failed bundle проверены 104 ZIP files и 86 raw streams; у preflight — 127 files и 102 streams. Native/BPF bytes в двух запусках совпадают с ec71. Различие результата не объясняется установленным build mismatch.

В failed record есть PID/TID и ранее положительно подтверждённое совместное владение file table, но нет имени или start time исчезнувшей задачи. Её роль и причина завершения неизвестны. Следующий допустимый диагностический шаг — вывести при том же отказе уже удерживаемые numeric identity/progress fields; без новых proc reads, ожиданий, повторных попыток или исключения для исчезнувшего task. Диагностика не является causal fix. Неизменённый failed job повторно не запускался.

Для отдельного PR #48 [проверены failed ZIP и 66 raw streams](evidence/2026-11-21-android-inventory-pr48.json); полное SHA256 этого небольшого failure archive пересчитано. Это более полная локальная проверка самого failed bundle, чем range-only чтение большого APK artifact в том же record. Новый inventory build/SDK verification успешен, legacy static fields трёх release reports совпадают с ec71, а исходный main trace guard остановил job до приложения. Этот отказ не свидетельствует об inventory regression и не заменяет investigation advanced PR #45.

Полный release gate REL-004 остаётся blocked. Нужны причинно обоснованная корректировка и один полный прогон согласованного main candidate с обязательными 7 200 s soak. Подпись, физическая установка и публикация по-прежнему следуют своим зависимостям. PR #46/#47/#48 в этой волне относятся к статическим locale/package проверкам и Windows cleanup; они не закрывают Android runtime отказ.

## Волны работы

1. **Наблюдаемость и точечная причина:** REL-001, параллельно анализ уже имеющихся evidence REL-002/003. Диагностический PR не называется runtime-fix.
2. **Один проверяемый кандидат:** после устранения подтверждённых причин REL-004; Windows REL-007 можно вести независимо. Новые продуктовые изменения сначала проходят свой адресный тест, затем попадают в общий кандидат.
3. **Подпись и установка:** REL-005 → REL-006. До действительного подписанного APK допустимы подготовленный комплект и инструкция, но не статус «production APK готов».
4. **Публикация:** REL-008 после закрытия применимых P0, без переименования старых previews в новую приёмку.

### REL-001

**Title:** Сохранить состояние Android при раннем отказе APK install

- **Priority:** P0.
- **Status:** `done`: ограниченная правка слита через [PR30](https://github.com/INNVoices/waarp/pull/30), head `fc0d549f259db23b2dc361f02b90c3bdcffb1a25`. 10 новых offline tests и 32 существующих preparation tests прошли; последующие Android failures сохранены ниже и не являются runtime acceptance.
- **Dependencies:** нет.
- **Files:** `scripts/android-install.py`, новый `scripts/android-install-test.py`, `.github/workflows/android.yml`, `docs/ANDROID.md`.
- **Change:** opt-in `--failure-report` только при явном serial эмулятора и подтверждении disposable CI. При отказе первого/тестового APK сохранить исходное исключение; через существующий ограниченный diagnostic runner проверить debuggable QEMU и прочитать package/settings service presence, PID framework, crash/recent logcat, kernel, memory/uptime и список процессов. Загрузить отчёт с существующим runtime artifact до teardown. Успешная установка и обычный локальный запуск не собирают полные логи.
- **Acceptance:** первая ошибка не заменяется ошибкой диагностики; install вызван один раз; повторная запись не уничтожает прежний failure bundle; команды только читают; сырой stdout/stderr имеет размер/hash/exit/timeout; unknown/missing/denied не становится success. Лимиты install 180 s, workflow и emulator resource budgets прежние; diagnostic limits берутся из существующих 12 s total / 2 s per command и stream caps. Нет root/unroot, restart, clear-log, retry или изменения tracefs.
- **Verification:** 10 новых installer tests и 32 existing preparation tests прошли локально; required Windows CI и dependency/AWG jobs PR30 успешны. Реальный API36 failure collector отработал за 0.524 s, сохранил исходный отказ, CRC ZIP и 22 raw hashes/bytes проверены. Android runtime acceptance остаётся незавершённой.

### REL-002

**Title:** Разобрать нестабильность framework API 29 без обхода PID/Binder guard

- **Priority:** P0.
- **Status:** `done` — PR #42 слит как f68e64ab63177afa00e96fd1d2d7cb7d6b895d8d. В run 44862192000 подтверждены service-drain barrier, новые PID, heap и shell identity, native 26/26 и release journey API 29. Это одна историческая PR-пара, не общая гарантия стабильности и не полный main acceptance.
- **Dependencies:** нет.

**Dependency notes:** нет; собственные failure diagnostics у подготовки уже существуют.
- **Files:** `scripts/android-emulator-prepare.py`, его `-test.py`, `.github/workflows/android.yml`; вход — `emulator-preparation.json` и raw diagnostics свежего API 29 job.
- **Change:** сопоставить accepted/new PID, `/proc` observations, `settings/package` Binder failures, boot/locale ordering и crash/kernel logs одного run. Сначала отделить завершение процесса, изменение имени/дочерние PID и потерю ADB. Менять только доказанную причину, сохраняя единственную запланированную инициализацию и исходные deadlines. Если данных не хватает — добавить одну адресную read-only запись, а не цикл «пока пройдёт».
- **Acceptance:** документ содержит source/run/job, raw record/hash и причинное основание правки либо конкретное `BLOCKED` с недостающим свидетельством. Ошибочные/malformed/stale PID и неизвестные ошибки Binder по-прежнему не проходят. В успешной подготовке новый framework, heap и shell identity действительно подтверждены перед fixtures/install.
- **Verification:** только относящиеся к гипотезе негативные fixtures + текущие preparation tests. Не более одного следующего обычного CI-наблюдения на законченную корректировку; не многократные rerun без изменения причины.

### REL-003

**Title:** Уточнить владение BPF trace event и допустимый путь подготовки 16 KiB

- **Priority:** P0.
- **Status:** `in_progress` — PR #45 ec71e72: preflight 44882755101 прошёл; full run 44882755131 имеет 6 success, 1 failure, 1 skipped. Его advanced observer отказал за 0.626 s: known_thread_missing / task_inventory_middle / missing_positive_shared_member, до second pass, GLOBAL и resize; причина исчезновения task неизвестна. Отдельный main-based PR #48 job 136958307750 отказал на прежнем eventsEnabled X / bpf_trace_printk guard до mutation и установки APK; PR45 observer в нём отсутствует. Следующий causal шаг — failure-only numeric metadata из уже имеющейся памяти; без новых reads, retries или ослабления guard.
- **Dependencies:** нет.
- **Files:** `scripts/android-ftrace-prepare.py`, его `-test.py`, `scripts/android-emulator-image.py`, `docs/ANDROID-PERFETTO-16K.md`; raw `ftrace-preparation` artifact.
- **Change:** исследовать конкретный image/kernel и источник включённого события до любой tracefs mutation. Проверенный exact kernel revision и permalink приведены ниже. Helper lookup может асинхронно включить событие, поэтому `X` совместим с нулём Perfetto sessions. Это объяснение механизма, не атрибуция actual guest. Подготовить проверяемый вариант, сохраняющий чужое состояние; если безопасный resize при таком состоянии не доказан, оставить отказ.
- **Acceptance:** различены факт enable, producer/helper lookup и текущий owner. Не считать `nop`, `tracing_on=0` и отсутствие perfetto PID доказательством отсутствия событий. Не выключать `bpf_trace_printk`, не разрешать произвольный `X`, не сбрасывать buffers/events. Итоговая корректировка должна иметь негативные tests активного/неизвестного owner, неизменённые 10 s/60 s/64 KiB budgets и реальные before/after records на согласованном образе.
- **Verification:** сначала read-only source/evidence review; существующие ftrace tests для малой правки; один следующий CI для этой гипотезы. Native/TUN приёмка не подменяется успешной подготовкой tracefs.

Проверенный полный kernel revision для REL-003: [`bb9513914902b52a9751ea1126ad40518a38c89f`](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/bpf_trace.c#L406-L425). В нём `bpf_get_trace_printk_proto()` планирует работу, вызывающую `trace_set_clr_event(..., 1)`; [`trace_events.c`](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/trace_events.c#L1287-L1296) использует верхний trace array. Даже успешная загрузка BPF-программы из одного enable не следует. Этот механизм не позволяет назначить виновным приложение Waarp, которое ещё не установлено.

### REL-004

**Title:** Получить полный exact-source Android acceptance bundle

- **Priority:** P0.
- **Status:** `blocked` — Полный ec71 / merge 8266058a run 44882755131 содержит failed optimized API 36 и skipped soak 7 200 s. Новый main-based PR #48 / merge ba9497f9: Android run 44940333222 также завершился 6 success, 1 failure, 1 skipped; API 36 отказал на прежнем events guard до APK install, soak 136960519754 skipped. Общий CI PR #48 успешен, но full production acceptance не выполнена. Требуются причинная корректировка REL-003 и полная exact-main матрица/soak; исторические successes и package build не складываются в приёмку.
- **Dependencies:** REL-001, REL-002, REL-003, REL-009.
- **Files:** `.github/workflows/android.yml`, `scripts/android-release-readiness.py`, `scripts/android-release-proof.py`, `docs/ANDROID_RELEASE_EVIDENCE.md`, `android/acceptance/README.md`. Не переписывать checker без конкретного воспроизводимого mismatch.
- **Change:** на одном выбранном main commit выполнить существующую полную Android acceptance. Экспортировать raw run/jobs и отдельные artifact receipts, original ZIP и точные extracted files; сверить SHA256/CRC и связность выбранной попытки. Статические отчёты привязать к трём реальным unsigned APK; runtime — к реально использованному payload, а не только versionName/code или `passed=true`.
- **Acceptance:** все восемь ожидаемых jobs завершились success, включая **7 200 реальных секунд** soak; никакие failed/skipped/cancelled результаты не маскируются. Нет смеси partial rerun artifacts разных попыток. Original ZIP digest, owning job upload window, source HEAD, три ABI, raw instrumentation/traffic/resources/crashes/16 KiB и unsigned payload проходят существующий checker. Report сохраняет `cryptographicCiProvenanceVerified=false`: доверие к API receipts обеспечено экспортирующим источником, а не самоописанием JSON.
- **Verification:** не запускать полный 2h pipeline для документационной правки. После адресных исправлений один полный candidate run и один offline checker replay. Если новая кандидатная сборка меняет payload, старый evidence нельзя переиспользовать как новый runtime pass. Положительный результат только отдельной API 35 исторической записи не закрывает эту задачу.

### REL-005

**Title:** Передать одобренные три APK существующей production-подписи

- **Priority:** P0.
- **Status:** `blocked`: ожидается REL-004; механизм подписи и pin уже `EXISTING`.
- **Dependencies:** REL-004.
- **Files:** `scripts/android-sign.py`, `scripts/android-verify.py`, `android/release-signing.json`, `docs/ANDROID.md`, `docs/ANDROID_RELEASE_EVIDENCE.md`; создаваемые reports вне Git с секретами не смешивать.
- **Change:** подготовить конкретный список accepted unsigned APK/hash/payload/version/ABI. В существующей доверенной среде применить `sign-apks`; затем независимо проверить три signed APK и `--require-signed` handoff. Агент может полностью подготовить комплект и проверять возвращённые публичные результаты; доступ к retained private key требуется только для самой операции подписи.
- **Acceptance:** сохранён production certificate; package `local.waarp.android`, nondebuggable/non-testOnly, intended version/code и ABI; каждый unsigned-source hash и ZIP payload совпадает с accepted input. В комплекте final SHA256 и signing reports. Нет `init-key`, переноса private key/password в CI, подмены pin или disposable CI certificate. Signing success сам по себе не означает runtime success.
- **Verification:** existing static verifier + bundle checker один раз на реальных финальных файлах. Не создавать подпись «для проверки» на новом ключе. Если secure signing environment недоступна, статус `BLOCKED` с готовым reviewable input manifest, не ложный `DONE`.

### REL-006

**Title:** Проверить подписанную Android установку и действительную границу обновления

- **Priority:** P0.
- **Status:** `blocked`: нет accepted production-signed candidate для этого шага; физический запуск в данном проходе `NOT_RUN`.
- **Dependencies:** REL-005.
- **Files:** `docs/ANDROID.md`, `docs/INSTALL.md`, release acceptance record; существующие `android/acceptance` сценарии использовать по применимости, не встраивать test hooks в production.
- **Change:** на идентифицированном физическом ARM64 Android проверить установку именно final signed hash, VPN consent, один контролируемый encrypted traffic сценарий, OFF/ON, сохранение состояния после перезапуска и удаление/повторную установку в согласованном тестовом профиле. Зафиксировать модель/OS/ABI/page size без личных identifiers. Дополнительное ARM32 устройство — отдельная явно заявленная строка покрытия, не вывод из ARM64.
- **Acceptance:** debug package `local.waarp.android.debug` и production `local.waarp.android` не перепутаны; их сосуществование/импорт объяснены. Исторический in-place upgrade заявляется только при наличии реального предыдущего production APK с подходящими certificate/versionCode и выполненном обновлении. При его отсутствии результат — первая production установка, без обещания протестированной миграции. Потеря/очистка данных после uninstall описана точно. Ключи и личные серверные конфигурации не попадают в record.
- **Verification:** одна короткая install/use/exit/install sequence на согласованном устройстве; существующая эмуляторная матрица не повторяется ради этой записи. Физические handover/Doze/privacy ограничения расширяет NET-006. При отсутствии доступного устройства подготовить сценарий и сбор безопасного evidence, статус оставить `BLOCKED`.

### REL-007

**Title:** Зафиксировать Windows portable runtime и жизненный цикл обновления

- **Priority:** P0.
- **Status:** `in_progress` — PR #43 уже слит (702112bcb0b93ab1c53f99d66970b544ecf37ce8): три portable запуска за 46.570 s на merge 061106b9. Новый PR #47 / tested merge 8e305059 прошёл три запуска за 49.745 s и все девять SVG; encrypted profile, settings и master OFF сохранены, normal exit/owned cleanup успешны. Его merge ожидает подтверждения владельца. Не проверены UAC, different-version upgrade/rollback, standard-user ACLs, физические sleep/network/other VPN; отдельный native test прошёл 50/50, OFF portable lifecycle не заменяет routing acceptance.
- **Dependencies:** нет.
- **Files:** `.github/workflows/ci.yml`, `.github/workflows/release-preview.yml`, `scripts/verify-package.mjs`, Windows native/lifecycle harness, `docs/V1.md`, `docs/INSTALL.md`, `engine/integrity.json`.
- **Change:** связать текущий Windows job, packaged portable hash, shipped engine/DLL/notices и реальные native/TUN evidence. Существующее покрытие отметить `ALREADY_DONE`; адресно закрыть только отсутствующую последовательность: первый запуск, отказ UAC, штатный выход, повторный запуск, замена portable EXE при остановленном приложении, чтение сохранённого профиля, осмысленный rollback. Проверять только собственные child/TUN resources; соседний VPN не трогать.
- **Acceptance:** сохранены process/TUN ownership и профиль; упаковка соответствует конкретному commit; clean exit/оставшиеся процессы и адаптеры наблюдались на Windows, а не эмулированы Linux unit tests. Нет автоматического удаления по похожему имени и нет бесконечного restart. Portable removal не выдаётся за MSI/NSIS uninstall. Если EXE остаётся unsigned, это явно отражено в канале/инструкции; новая code-signing identity не выдумана. Ранее встречавшийся child-exit timeout считается устранённым только при подтверждённой причине и адресном результате.
- **Verification:** сначала прочитать fresh job artifacts и existing native coverage; затем максимум один ограниченный Windows lifecycle run для непокрытого случая. Существующие iteration/time budgets не увеличивать; Linux skips записывать как `NOT_RUN`, а не pass Windows.

### REL-008

**Title:** Добавить явный путь публикации одобренных production-файлов

- **Priority:** P1; включение production-канала заблокировано незакрытыми P0.
- **Status:** `blocked`. Текущий `stable.yml` выпускает source/developer комплект с Android debug APK; это обозначенный существующий канал, а не production signing pipeline.
- **Dependencies:** REL-005, REL-006, REL-007, NET-001, NET-002, NET-004.
- **Files:** `.github/workflows/stable.yml`, `release/stable.md`, `docs/RELEASES.md`, `docs/INSTALL.md`, `docs/ANDROID_RELEASE_EVIDENCE.md`; публичные download metadata согласовать с distribution-агентом.
- **Change:** подготовить минимальный отдельный publication contract, потребляющий уже проверенный signed bundle без пересборки/переподписания. Явно связать tag/source, asset hashes, evidence report, платформы и поддержку обновления. Закрывать issue [#25](https://github.com/INNVoices/waarp/issues/25) по его фактическим acceptance, не только по наличию checker.
- **Acceptance:** публикация отклоняет отсутствующий/failed/mismatched evidence; три реальные production APK не перепутаны с debug; final downloads совпадают по SHA256 с одобренными файлами; release notes не приписывают ARM runtime/API36/historical upgrade, которых не было. Открытые ограничения остаются видны. Preview ссылки действуют до появления конкретной замены. Автоматическая публикация не начинается от одного изменения документации или номера версии.
- **Verification:** offline malformed/missing/stale-bundle cases для publication input; один reviewable draft набора files/notes. Реальное размещение выполняется только с конкретными accepted artifacts и уже предоставленной авторизацией. Каталоги оцениваются отдельно; принятие каталога не является доказательством безопасности или production acceptance.

## Завершение работы агентом

В отчёте каждого PR: task IDs, base/head, изменённые paths, точные проверки `PASS/FAIL/NOT_RUN`, raw evidence URLs/IDs/hashes и оставшийся gate. Приложение не объявляется сломанным из-за prep failure; candidate не объявляется готовым из-за общего CI. Не использовать отсутствие новых reports как доказательство отсутствия проблемы. Результат этого корпуса — воспроизводимая передача одобренного кандидата, а не новая система CI ради самой системы.

### REL-009

**Title:** Разобрать graphics/framework crash API 36 до установки приложения

- **Priority:** P0.
- **Status:** `done` — PR #44 слит как 202c70125daf94bb8499c3b758420cd9ce90a52f. Run 44864148533 подтвердил создание AVD cmdline-tools 20.0 с target android-36.1 на прежнем image/backend и native API 36: 26/26. Старый android-0 target не правили вручную; tracing REL-003 и полный candidate/soak остаются отдельными незакрытыми gates.
- **Dependencies:** нет.
- **Files:** `.github/workflows/android.yml`, `docs/ANDROID.md`, `docs/ANDROID-PERFETTO-16K.md`, `docs/production/evidence/2026-11-21-pr30-install.json`; upstream source только как read-only evidence.
- **Change:** сопоставить точные emulator version, Android image revision, ABI/page size и graphics backend из job/provenance с assertion `GoldfishMapper::readFromHost` / `hasReadColorBufferDma`. Найти соответствующий AOSP/gfxstream код и допустимую конфигурацию или upstream исправление. Отделить SurfaceFlinger crash, последующий framework restart и отсутствие package/settings от независимого ftrace blocker REL-003. После source review предложить один ограниченный воспроизводимый эксперимент; менять только подтверждённую причину.
- **Acceptance:** timeline показывает, что crash предшествовал install; гипотеза привязана к фактическим версиям и исходникам. Если нужна правка — один minimal diff и before/after одинакового сценария с сохранением PAGE_SIZE, VPN/UI tests, test count, tracing guards и прежних deadlines. Отрицательный результат остаётся failure; нельзя отключить RegionSampling, UI rendering или проверку правильной страницы только ради прохождения CI.
- **Verification:** сначала read-only review сохранённого bundle и первичного кода. Затем не более одного адресного disposable-emulator experiment на подтверждённую гипотезу; без веера flags/retries. Production candidate требует полной REL-004 matrix независимо от локального успеха. Этот task не утверждает дефект VPN или universal emulator fix.
