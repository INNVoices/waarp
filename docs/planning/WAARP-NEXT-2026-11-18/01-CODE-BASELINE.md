# Waarp: фактическая база для следующего этапа

**Дата:** 18.11.2026. **Уровень доказательства:** чтение исходников (`SOURCE`), без нового запуска приложений, нативных экспериментов и сетевых измерений. **Статус работы:** только подготовка; реализация ждёт команды владельца.

## 1. Зафиксированный срез

Аудит выполнен по дереву `37421f5f5bffbea0391a39719ea7185923925897`, соответствующему `INNVoices/waarp@f66e5def3d689837db010c3453086a832c701fcc`. Локальный подготовительный снимок `e85e864` имеет то же дерево; локальная история не подменяет публичный SHA. Все ссылки на код ниже закреплены на публичном коммите. Новый `main` перед началом реализации нужно сравнить по [07-HANDOFF.md](07-HANDOFF.md), поскольку соседний исполнитель продолжает работу.

Проверено приложение с уже существующими карточками приложений/маршрутов, личными и публичными подключениями, Auto, диагностикой, проверкой передачи, подбором совместимых вариантов и живым применением маршрутов. Новое ТЗ развивает эти механизмы. Оно не задаёт второй VPN-клиент внутри Waarp.

| Слой | Закреплённая основа | Значение для подготовки |
|---|---|---|
| Windows | Отдельный процесс sing-box-lx `1.14.2-lx.11`, source `3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d` | Управление через локальный API и конфигурацию; наличие функции в более новом ядре Android не переносится на desktop |
| Android | JNI/libbox `1.14.4-lx.35-waarp.2`, source `f1bac271853eaf13398ce1030c948aebc3aed2e1` | Проверять экспорт фактического AAR и build tags; текущие downstream-исправления нельзя потерять при обновлении |
| Продуктовый статус | RC/бета и действующая приёмка предыдущих изменений | Пользовательское «стабильно на моих ПК/Android» — наблюдение владельца, не измеренная матрица всех сетей |

Основание: [desktop SOURCE.md](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/engine/SOURCE.md), [Android native-source.json](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/native-source.json), [существующая приёмка](../../ROUTE-AND-CONNECTION-AUDIT-2026-11-18.md). Ниже слово «есть» означает наличие реализации, если отдельно не указан иной уровень доказательств.

## 2. Опорные места в коде

Ссылки — навигация для следующего исполнителя, а не список файлов, которые обязательно менять. Точки расширения нужно заново сверить с актуальным `main`.

### Windows

| Код и символы | Уже существующая ответственность | Что брать в новый этап |
|---|---|---|
| [engine.ts:436–537 — `Engine.liveApply`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/engine.ts#L436-L537) | Подготовка пути, барьер изменяемых правил, ACK selectors/rule files, закрытие затронутых потоков, фиксация runtime | Единственный путь изменения живой маршрутизации; расширить классификацию изменения |
| [engine.ts:538–643 — `restoreLive`, `writeRules`, `closeTouched`, `drop`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/engine.ts#L538-L643) | Откат, atomic rename, DNS-свидетели применения, точечное закрытие соединений | Сохранить подтверждение фактического применения; различить строгую политику и улучшение пути |
| [apply.ts:1–104 — `ApplyResult`, `createApply`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/apply.ts#L1-L102) | Различение сохранённого намерения и применённого состояния; ревизия главного переключателя; запрет скрытого restart от карточки | Не рисовать успех по одному сохранению JSON; OFF сохраняет приоритет |
| [live-outbound.ts:18–166 — `LiveOutbounds`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/live-outbound.ts#L18-L166) | 16 заранее описанных SOCKS-слотов; ленивые отдельные workers без TUN; проверка идентичности; cleanup | База для позднего подключения и будущего удержания старого worker, но flow reference counting пока отсутствует |
| [runtime-pool.ts:1–29 — `runtimePreload`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/runtime-pool.ts#L1-L27) | Ограниченный preload личных путей, ограничения для AWG/OpenVPN/public | Не раздувать фоновые подключения ради карты или сравнений |
| [groups.ts:10–111 — `firstAlive`, `stickyFastest`, `withAuto`, `autoSample`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/groups.ts#L10-L108) | Один логический `g-auto`, ограниченные измерения, удержание здоровой активной сессии | Сохранить anti-flap и допустимый пул; добавить scope приложения до персональных рекомендаций |
| [engine.ts:397–430, 774–816 — health round, `fbStep`, `groupStep`, `delay`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/engine.ts#L397-L430) / [выбор](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/engine.ts#L774-L816) | Периодический владелец здоровья/Auto; 15 секунд между раундами; selector выбирает Waarp | Новая оценка — вход существующего владельца, не ещё один таймер или upstream auto-picker |
| [index.ts:940–1003 — `diagnose`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/index.ts#L940-L1003) | Прямая слоистая проверка + ограниченные проверки личных путей к цели, cancellation, fingerprint сети, доказательство | Общая база для «подобрать» и «объяснить» уже есть |
| [index.ts:1060–1075 — `diagnose:apply`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/index.ts#L1060-L1075), [diagnosis.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/diagnosis.ts) | Применение main-issued proof к доменному маршруту, TTL 5 минут, проверки профиля/сети/контекста | Не превращать результат для приложения в широкое доменное правило без явного scope |
| [layered.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/layered.ts), [shared/evidence.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/evidence.ts), [checker.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/checker.ts) | DNS/TCP/TLS/HTTP, осторожная классификация, отдельная аренда checker без TUN | Дополнить модель provenance и capabilities; не переписывать диагностический стек |
| [payload-check.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/payload-check.ts), [tune.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/tune.ts) | Проверка полезной передачи; ограниченные совместимые варианты с явным применением | Существующие уровни глубокой проверки, а не повод сделать новый speedtest/config generator |
| [netid.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/netid.ts), [netmemory.ts:1–55](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/netmemory.ts#L1-L55), [last-session.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/last-session.ts) | Локальный salted fingerprint, память успешных путей, небольшой очищенный отчёт последней сессии | Повторное использование cache/redaction; никакой обязательной облачной истории |
| [catalog-pool.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/catalog-pool.ts), [catalog.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/catalog.ts), [presets.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/presets.ts) | Каталог, readiness, стабильные идентификаторы, текущие правила сервисов | Atlas — представление той же модели; app profile — малое дополнение preset/rule |

### Android

Префикс исходников в ссылках: `android/app/src/main/java/local/waarp/android/`.

| Код и символы | Уже существующая ответственность | Что брать в новый этап |
|---|---|---|
| [MobileRepository.kt:144–239 — `edit`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/MobileRepository.kt#L144-L239) | Mutex изменений, ревизии, live apply перед записью, rollback; отдельное согласование structural restart | Сохранить одного process-level владельца маршрутизации, не переносить его в Compose/ViewModel |
| [MobileRepository.kt:257–350 — `probe`, `selectPaths`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/MobileRepository.kt#L257-L350), [SelectionPolicy.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/SelectionPolicy.kt) | Один probe mutex, выборка, session guards, native URLTest, Auto/fallback | Единое расписание и общая память измерений; результаты не разрешают менять чужие карточки |
| [MobileLiveRouting.kt:15–18, 28–32, 100–281](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/MobileLiveRouting.kt#L15-L281) | Совместимость по directory/signature, фиксированный native graph, local rule sets и selectors | Ключевая граница обычного live apply и структурного изменения |
| [LiveRoutingFiles.kt:67–117 — `apply`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/LiveRoutingFiles.kt#L67-L117) | Atomic публикация, fsync, guard, native witnesses/ACK, восстановление старой конфигурации | Не считать запись файла применением; при неизвестном результате сохранять барьер и честное состояние |
| [VpnController.kt:103–153](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/VpnController.kt#L103-L153), [WaarpVpnService.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/service/WaarpVpnService.kt) | Главный lifecycle, durable ON/OFF, generations, foreground service | OFF сразу инвалидирует старые операции; поздний результат не воскрешает VPN |
| [LibboxBackend.kt:76–172 — `start`, control-stream recovery](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/LibboxBackend.kt#L76-L172) | Native start, готовность TUN, потоки состояния; восстановление control stream отдельно от TUN | Не выдавать временную потерю телеметрии за пустой список сессий или требование restart |
| [LibboxBackend.kt:210–258 — `fetchOutbound`, `urlTest`, `closeConnection`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/LibboxBackend.kt#L210-L258) | HTTP по выбранному tag, отменяемый command request, точечное управление соединениями | Реальная доступная сегодня поверхность API; UDP/jitter по ней не измеряются |
| [LibboxBackend.kt:379–409 — connection stream](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/LibboxBackend.kt#L379-L409) | Метаданные потоков, outbound/chain/package, счётчики; bounded список для UI и отдельные active tags | База контекста приложения и охраны активных сессий, не счётчик UDP-потерь |
| [AndroidPlatform.kt:245–405 — `PhysicalNetworkMonitor`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/AndroidPlatform.kt#L245-L405) | Физические non-VPN сети, callback в native, handover при новом Network/исчезнувшем адресе на том же интерфейсе | Мобильная смена сети уже обрабатывается; сохранение внешней сессии требует отдельной приёмки |
| [NetworkTools.kt:214–285 — target/diagnose](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/NetworkTools.kt#L214-L285), [MobileViewModel.kt:476–495](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/MobileViewModel.kt#L476-L495) | Прямая DNS/DoH/TCP/TLS/HTTP-проверка и сравнение путей к адресу | Детектив уже существует; его расширять контекстом и доказательствами |
| [MobileViewModel.kt:508–564, 657–749](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/MobileViewModel.kt#L508-L749), [LastSessionEvidence.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/LastSessionEvidence.kt) | Проверка передачи, подбор вариантов, очищенный отчёт | Сохранить ограничения, cancellation и явное применение |
| [Models.kt:112 — `Presets`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/Models.kt#L112), [PublicCatalog.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/PublicCatalog.kt) | Существующие назначения правил и публичный каталог | Общие продуктовые контракты без переноса desktop-вёрстки на телефон |

## 3. Сильная база, которую не надо реализовывать повторно

### 3.1. Диагностика и подбор уже связаны

На Windows `diagnose` параллельно проверяет прямой путь по уровням и доступные личные пути к той же цели. При ON используется действующий engine; при OFF берётся lease единственного checker без TUN. Общий deadline — 20 секунд. Результат связывается с физической сетью, текущим runtime-контекстом и подписями профилей. Память сети переставляет допустимые личные кандидаты, а не создаёт новые правила и не добавляет Direct. Применение защищено краткоживущим proof из main. [Исходник](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/index.ts#L940-L1003), [deadline](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/index.ts#L1717), [память](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/netmemory.ts).

На Android прямая проверка использует физическую non-VPN сеть, затем `repository.probe(url=...)` проверяет тот же адрес через допустимые профили. Пока результат — рекомендация отдельного маршрута к адресу; полноценного единого `EvidenceToken` с одинаковой desktop-семантикой у этого UI-потока нет. Нельзя объявить одинаковые кнопки равенством платформенных гарантий. [MobileViewModel.diagnose](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/MobileViewModel.kt#L476-L495).

Прямая слоистая проверка и проверка через путь сейчас имеют разную глубину. У каждого выбранного outbound нет автоматически доказанного полного набора DNS→dial→TLS→payload. Успех URLTest — доказательство конкретного HTTP(S)-запроса; он не измеряет игровой RTT, UDP-потери, пригодность голосовой сессии, загрузку сервера или успешный вход в приложение. [Desktop `probePaths`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/engine.ts#L864-L891), [Android `urlTest`](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/LibboxBackend.kt#L227-L255).

### 3.2. Auto уже осторожен, но общий

`g-auto` — синтетическая группа личных неотозванных подключений. Публичные узлы и Direct в неё не добавляются. Кандидаты измеряются ограниченной выборкой; неизмеренный не становится неработающим. Здоровый выбор удерживается. Для переключения по скорости требуется выраженный перевес на протяжении пяти раундов; активные соединения блокируют такое улучшение. Это существующая ценная защита, а не новая киллерфича. [groups.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/groups.ts#L10-L108).

Группа сейчас общая: изменение `grp-g-auto` влияет на всех, кто на неё ссылается. Измерение одной игры не должно молча передвигать браузер, загрузку и чужую карточку. До app-specific Autopilot нужно определить scoped selection поверх текущих карточных selectors, сохранив общий набор профилей. Возможность измерить путь ещё не даёт разрешения выбрать его для всех приложений.

### 3.3. Полезная передача и совместимые варианты уже реализованы

В обеих платформах есть контролируемая проверка полезного download и явный upload на собственный HTTPS endpoint пользователя. Это не произвольный speedtest: у проверки конкретные байты/контрольная сумма и ограничения. На Android JNI-ответ строковый, поэтому нельзя просто подключить бинарную throughput-методику к существующему `fetchOutbound` и назвать её готовой. Подбор транспорта уже ограничивает варианты, держит исходный вариант и требует явного актуального применения. Следующий этап переиспользует эти операции через общий арбитр. [Текущий отчёт с границами](../../ROUTE-AND-CONNECTION-AUDIT-2026-11-18.md), [payload-check.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/payload-check.ts), [MobileViewModel.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/MobileViewModel.kt#L508-L564).

Последняя сессия уже хранит очищенные события и доступна после выключения. Лимит — 48 событий / 64 КиБ. Это правильное место для кратких причин решения; новый полный сетевой recorder, постоянная выгрузка логов и дублирующий диагностический журнал не нужны. [Windows](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/last-session.ts#L1-L11), [Android](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/LastSessionEvidence.kt).

## 4. Непрерывность: что действительно происходит сейчас

### 4.1. Сохранение TUN не равно сохранению изменяемой сессии

На Windows обычное live-изменение не перезапускает основной core/TUN. Однако конфиг selectors устанавливает `interrupt_exist_connections: true`, `liveApply` вызывает `closeTouched`, а после успешного изменения `relays.trim` останавливает неиспользуемые workers. Точечное закрытие намеренно пересчитывает эффективное первое правило до и после изменения: соседний незатронутый поток должен сохраниться, изменённый поток должен перестать следовать старой политике. [awg.ts:528](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/awg.ts#L528), [awg.ts:633](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/awg.ts#L633), [awg.ts:754–755](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/awg.ts#L754-L755), [engine.ts:502–535](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/engine.ts#L502-L535).

На Android selectors групп, fallback и изменяемых карточек также включают прерывание. `LiveRoutingFiles.apply` обновляет совместимый граф без полной перезагрузки, но это не обещает сохранение затронутого TCP/UDP. [RoutingCompiler.kt:125,165](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/RoutingCompiler.kt#L125-L165), [MobileLiveRouting.kt:158–160](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/MobileLiveRouting.kt#L158-L160).

Следовательно, задача следующего этапа — осознанно изменить семантику **мягкого улучшения разрешённого пути**, сохранив немедленное действие запрета, отзыва и явного изменения границы маршрутизации. Глобальная замена `true` на `false` недостаточна и может нарушить текущие гарантии. Кроме native interrupt остаются `closeTouched`, lifetime workers, изменение DNS/правил, строгий Direct/Block и поколение конфигурации. В закреплённом upstream selector внутренние соединения прерываются отдельно; точную семантику обоих бинарников проверять в ограниченном эксперименте. [Исследование upstream](03-OPEN-SOURCE-REUSE.md).

### 4.2. Возврат с fallback неодинаков

Windows `FbTracker` переключается на проверенный fallback после трёх неуспешных раундов основного и возвращается после трёх успешных раундов; проверки занятости в самом `FbTracker` нет. Android возвращается на primary только при известной телеметрии и отсутствии активных потоков у соответствующего selector. Это различие исходников, а не измеренный пользовательский дефект. Новый контракт должен одинаково ограничивать необязательное возвращение на основной путь и проверяться существующими harness. [Windows fallback.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/fallback.ts#L1-L35), [Android selectPaths](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/MobileRepository.kt#L320-L350).

### 4.3. Настоящая смена физической сети — отдельный класс

Android уже следит за физической сетью, адресами и native default interface. На одном и том же `wlan0` новый Android `Network` или потеря адреса вызывает явную invalidation перед обновлением native. Это помогает ядру перестроить привязанные сокеты, но не доказывает миграцию внешнего соединения между разными IP/выходными серверами. Переключение селектора, Wi-Fi→мобильная сеть и отказ прежнего сервера должны иметь раздельные результаты приёмки. [PhysicalNetworkMonitor.notifyListener](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/core/AndroidPlatform.kt#L355-L385).

## 5. Матрица возможностей и ограничений

`SOURCE` ниже не означает «проверено нами в настоящей сети».

| Возможность | Windows на этом срезе | Android на этом срезе | Решение для следующего этапа |
|---|---|---|---|
| HTTP(S) через конкретный загруженный профиль при ON | `Engine.probePaths`, локальный API delay; diagnostic proxy для полезной передачи | `urlTestOutbound`, `getURLViaOutbound`, native generation guards | Переиспользовать. В модели отделять control URL от цели приложения |
| Проверить сохранённые профили при OFF без захвата TUN | Lease `Checker` | `Headless`/`checkOutbounds`, один controller ownership | Переиспользовать; OFF сам по себе не разрешает включение VPN |
| Проверить новый произвольный публичный узел при ON | Отдельный bounded checker/late-worker path с public preflight | В `repository.probe(extra=public)` явно требуется OFF и `preparePublic` | Возможность Android исследовать отдельно; UI не обещает действие, которое ведёт к скрытому restart |
| Добавить поздний outbound без замены основного TUN | 16 live SOCKS-слотов и workers без TUN; не всякое структурное изменение допустимо | Аналогичной динамической схемы в приложении нет; preload нескольких личных профилей, фиксированная signature | Android parity — feasibility gate, а не галочка в ТЗ |
| Изменить совместимый маршрут | Selectors + local rule sets + ACK; core/TUN сохраняется | Selectors + watched local rule sets + ACK при совместимой signature | Развивать существующий механизм |
| Изменить native graph за пределами подготовки | Live apply отказывает и сохраняет текущую сессию; карточка не вызывает restart автоматически | Отдельное согласование structural restart, затем pause/save/resume | Autopilot не запрашивает такой restart как повседневный шаг |
| Удержать текущий выбор при активной игре/загрузке | `stickyFastest` учитывает active conns | `SelectionPolicy`, `activeFlowTags`; unknown считается занятым | Сохранить как консервативную основу |
| Сохранить изменяемый TCP/UDP при смене selector | Сейчас interrupt true и targeted close | Сейчас interrupt true | Требуется эксперимент и новая классификация; готовой гарантии нет |
| Staged диагностика DNS/dial/TLS по заданному пути | Текущие уровни преимущественно Direct, пути — HTTP result | Текущие уровни Direct; upstream pinned `StartConnectionTest` потенциально даёт больше | Проверить экспорт/route binding; адаптер в имеющуюся модель, без нового диагностического продукта |
| UDP RTT, jitter, loss к сервису | Текущий health/HTTP API не даёт | Текущий Kotlin API не даёт; upstream packet route не равен UDP service test | Только отдельный контролируемый endpoint/протокол и явный scope результата |
| NAT/STUN, throughput/RPM | В pinned upstream есть кандидаты повторного использования | Аналогично; standalone default dialer не доказывает selected path | Capability spike на фактическом binary/AAR, учитывать стоимость и лицензию |
| Карта/точные координаты | Каталог извлекает country из имени; точной модели geo нет | Аналогичные подсказки каталога; полноценной модели Atlas нет | GeoHint с источником/точностью; неизвестные остаются видимыми |
| Загрузка сервера | Нет достоверной модели/API в приложении | Нет достоверной модели/API в приложении | Не выводить её из ping или количества локальных соединений |
| Профиль качества для приложения | Есть presets/rules и process metadata; нет цельной модели пригодности | Есть presets/package metadata; нет цельной модели пригодности | Небольшие declarative требования поверх существующих правил |

Основания матрицы: ссылки §2–4; подробная проверка exact upstream pins и API — [03-OPEN-SOURCE-REUSE.md](03-OPEN-SOURCE-REUSE.md). В закреплённом Windows core режим URLTest `failover` отсутствует, в закреплённом Android source присутствует; `least_test`, `round_robin` и `sticky_hash` есть в обоих. Это не отменяет уже существующий fallback, которым управляет сам Waarp. Native `failover` не заменяет действующего владельца Auto и не означает перенос старого TCP-сокета.

## 6. Ограничения ресурсов уже являются частью дизайна

Эти числа прочитаны в коде; они не являются результатом измерения производительности.

| Контур | Существующее ограничение | Следствие |
|---|---|---|
| Desktop Auto/checker | 8 кандидатов на выборку; до 16 Auto-only активных кандидатов сверх явно используемых | App profiles не умножают проверки на число карточек |
| Desktop preload | До 64 профилей; до 16 endpoint-type путей в логике preload; OpenVPN/public не прогреваются скрыто | Сохранить lazy-поведение и ограничения AWG-ключей |
| Desktop late paths | 16 заранее описанных slots | Будущее удержание старых сессий потребляет тот же ограниченный ресурс |
| Android preload | До 4 дополнительных личных профилей | «Все серверы всегда готовы» сейчас неверно |
| Android watchers | Максимум 112; фактический бюджет учитывает inotify с резервом 16 | Сложность правил имеет системную цену; карта не создаёт rule sets |
| Desktop публичный pool | 10 000 записей; 48 МиБ внутреннего pool; readiness 5 минут; история 8 наблюдений | Просмотр карты не запускает весь pool; restored cache не считается свежим успехом |
| Android public/library | `MAX_PROFILES=2000`; health TTL 5 минут | Визуализация работает с ограниченным snapshot и существующими страницами |
| Last session | 48 событий / 64 КиБ | Хранить причины/стадии, а не packet capture |
| Desktop netmemory | TTL 24 часа; до 512 записей в bucket | Исторический успех помогает очереди кандидатов, не разрешает немедленный apply |

Источники: [groups.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/groups.ts), [runtime-pool.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/runtime-pool.ts), [live-outbound.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/live-outbound.ts), [MobileLiveRouting.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/MobileLiveRouting.kt#L28-L32), [catalog-pool.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/main/catalog-pool.ts#L10-L20), [Android Models.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/Models.kt#L12), [PublicCatalog.kt](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/main/java/local/waarp/android/data/PublicCatalog.kt#L26), [netmemory.ts](https://github.com/INNVoices/waarp/blob/f66e5def3d689837db010c3453086a832c701fcc/src/shared/netmemory.ts#L7).

## 7. Согласование с уже существующим исследованием

Корпус [NETWORK-RESILIENCE-2026-11-17](../../research/NETWORK-RESILIENCE-2026-11-17/README.md) прочитан вместе с обновлённой приёмкой 18 ноября. Его исходный SHA старше текущего; записанные там «следующие задачи» нельзя вслепую скопировать в новый backlog.

| Ранее поставленное направление | Что видно в текущем коде/отчёте | Роль в новом ТЗ |
|---|---|---|
| N01 явный fingerprint; N05 MASQUE; N08 parity | Уже есть целевые изменения импорта и platform checks | Не реализовывать повторно; новое core/API reuse не ухудшает их |
| N02 полезная передача | Есть download/upload и честное «не измерялось» | Один из видов Observation |
| N03 последняя сессия | Есть локальный bounded redacted report | Источник объяснения после OFF |
| N04 расположение обратной связи | Есть отдельная работа UI/соседнего исполнителя | Новые состояния интегрировать без повторного регресса кнопок/уведомлений |
| N06 совместимые варианты | Есть ограниченный подбор и явное применение | Расширять доказательную базу через тот же owner |
| N07 служебные загрузки | Есть явный Direct/личный путь, без скрытого Direct fallback | Atlas/источники не обходят эту политику |
| N09 полевая матрица | Не закрыта наличием unit/CI | Отдельная реальная проверка перед публичным обещанием качества/непрерывности |
| N10 исследовательские транспорты | Исследование, не обязательное внедрение | Не расширять объём без показанной пользы |

Основание: [план N01–N10](../../research/NETWORK-RESILIENCE-2026-11-17/04-IMPLEMENTATION.md), [актуализация и ограничения приёмки](../../ROUTE-AND-CONNECTION-AUDIT-2026-11-18.md), [TZ-PROGRESS](../../TZ-PROGRESS.md). Показатели прошлых CI не переписаны как результаты этого исследования.

## 8. Как проверять продолжение

Существуют focused проверки `test/groups.check.ts`, `test/live-outbound.check.ts`, `test/live-outbound-races.check.ts`, `test/routing-dns-priority.check.ts`, native `test/connection.live.ts` / `test/live.stress.ts`; на Android — `LiveRoutingFilesTest`, `MobileLiveRoutingTest`, `SelectionPolicyTest` и `VpnLifecycleInstrumentedTest`. Они являются точками расширения, не основанием написать второй параллельный набор. Например, текущие проверки намеренно ожидают interrupt и закрытие изменённого потока: новая мягкая семантика потребует осмысленно разделить этот oracle на soft switch и hard revoke. Нельзя просто ослабить ожидания всех тестов. [Desktop checks](https://github.com/INNVoices/waarp/tree/f66e5def3d689837db010c3453086a832c701fcc/test), [Android tests](https://github.com/INNVoices/waarp/tree/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/test), [instrumentation](https://github.com/INNVoices/waarp/tree/f66e5def3d689837db010c3453086a832c701fcc/android/app/src/androidTest).

Следующая проверка должна отвечать на конкретный вопрос: сохранён ли старый поток; какой путь использует новый; затронут ли сосед; не прошёл ли запрещённый трафик; не применился ли устаревший результат; сохранился ли master OFF. Сохранение PID/TUN само по себе не закрывает эту приёмку. Детальные контракты и feasibility gates — [04-TECHNICAL-SPEC.md](04-TECHNICAL-SPEC.md), последовательность — [05-PLAN-AND-ACCEPTANCE.md](05-PLAN-AND-ACCEPTANCE.md).

**В этом проходе:** исходники прочитаны, разрывы и точки переиспользования документированы. Новые сетевые функции, экраны, зависимости, binary pins и тестовые результаты не созданы. Технические гипотезы остаются гипотезами до команды владельца и соответствующего ограниченного эксперимента.
