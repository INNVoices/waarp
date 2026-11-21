# 04. «Липучка»: Android Chameleon, восстановление входа и companion-границы

**Основание:** `main` `63fc7930abfeac1b870e9c8e3fabc500768f419e`, чтение 2026-11-21. **Исходное ТЗ найдено:** [ANDROID-CHAMELEON-2026-11-18.md](../ANDROID-CHAMELEON-2026-11-18.md). Оно относится к Waarp Android. Ниже — агентская декомпозиция этого запроса, а не перенос требований другого проекта. Новая sticky-реализация в этом проходе не создавалась.

## 1. Что именно просил пользователь

Сделать приложение менее заметным в обычном launcher и дать добровольно настроить вызов Waarp по определённому элементу/действию в другом установленном приложении. Стороннее APK не должно требовать модификации, плагина или согласованной интеграции. После открытия пользователь получает настоящий интерфейс Waarp; возврат использует нормальные правила Android tasks. Режим отключаем и восстановим.

Это не эквивалент трея, обычного hotkey или интеграции через API. Это также не обещание скрыть установленный пакет, активный VPN и системные разрешения от Android Settings, администратора или проверки устройства. Найденное исходное ТЗ прямо ограничивает цель обычной обнаруживаемостью и оставляет cross-app trigger на стадии feasibility. Эти ограничения входят в продуктовый контракт.

## 2. Что есть в текущем коде

| Область | Подтверждённое состояние |
| --- | --- |
| Android entry | `AndroidManifest.xml`: обычный `MainActivity` с MAIN/LAUNCHER, SEND и `waarp://import`; `activity-alias`, `AccessibilityService` и overlay-разрешение отсутствуют |
| Android lifecycle | `WaarpApplication.kt` владеет `MobileRepository`/`VpnController`; `WaarpVpnService.kt` отдельно от Activity. `MainActivity.onStop/onDestroy` отменяют незавершённое согласие на restart, а не превращают скрытие UI в OFF |
| Android sticky | Есть концепция; нет реализованного выбора чужого UI-элемента, armed state, launcher alias или нейтрального cover |
| Windows companion | Реализованы [local bridge](../BRIDGE.md), `src/main/bridge.ts`, `src/shared/companion.ts`, `pages/companionpick.tsx`. `routes.open` показывает существующий маршрут/выбор, `routes.ensure` — отдельно ограниченная мутация. Это интеграция сотрудничающего приложения, не произвольный чужой button |
| Windows visibility | `src/main/index.ts`: hide-to-tray, show/focus, single instance и сохранение bounds. Нет подтверждённого механизма прикрепления к произвольному внешнему окну |

Пути Android-кода далее относительно `android/app/src/main/java/local/waarp/android/`. Существующий `START_STICKY` службы означает механизм восстановления Android service, а не функцию «липучки».

## 3. Реалистичные режимы и ограничения платформы

| Режим | Продуктовое назначение | Условие поставки |
| --- | --- | --- |
| Нейтральный собственный entry/cover | Альтернативный добровольный вход в настоящий Waarp | Только собственная идентичность и ресурсы; не имитировать чужое приложение/системное подтверждение; сначала проверить восстановление обычного входа |
| Управление своим launcher alias | Выбор видимого entry, а не исчезновение пакета | Android/OEM acceptance; не отключать последний рабочий путь управления |
| Trigger выбранного элемента чужого приложения | Исходная «липучка» | Только наблюдаемый поддержанный event, явное пользовательское разрешение, допустимый foreground-entry путь; несовместимые приложения обозначаются как неподдерживаемые |
| Произвольная пиксельная точка / встраивание в чужой APK | Более сильное обещание, которого исходное ТЗ не гарантирует | Не объявлять универсальной возможностью stock Android |
| Windows context panel | Возможное будущее удобство около выбранного окна | Optional P2; не является заменой или блокером Android-запроса |

**Проверенные первичные основания.** [Activity aliases](https://developer.android.com/guide/topics/manifest/activity-alias-element) принадлежат той же программе и могут иметь свой launcher entry. [AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService) включается пользователем через Settings; [настройка событий](https://developer.android.com/guide/topics/ui/accessibility/views/service) позволяет ограничить packages и типы событий. Эти API не гарантируют, что любой произвольный control выдаст пригодный event. [Background Activity Launch](https://developer.android.com/guide/components/activities/secure-bal) ограничивает появление Activity из фона и меняется с target/API. [VPN guide](https://developer.android.com/develop/connectivity/vpn) описывает системное согласие, Settings и видимость VPN — presentation-режим их не отменяет.

**Дистрибуция.** Android API reference позиционирует Accessibility для помощи пользователям с ограничениями. [Google Play policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en) отдельно регулирует другие применения: disclosure/consent, декларация и review; простая детерминированная пользовательская автоматизация не означает автоматического одобрения. Нельзя отмечать Waarp `isAccessibilityTool=true` без соответствующего основного назначения. Наличие sideload APK не доказывает совместимость с OEM и не заменяет платформенное согласие. Решение о допустимом канале поставки должно предшествовать включению observer в production variant.

## 4. Предлагаемый контракт реализации

Это проектирование на основе найденного ТЗ; названия новых файлов/типов ниже не означают, что они уже существуют.

### 4.1. Состояние входа отдельно от VPN

`Disabled → Draft → PermissionRequired → Armed`; отдельные исходы `Unsupported`, `TargetStale`, `PermissionRevoked`. Показ обычного Waarp — краткое действие, а не состояние VPN. Отзыв permission, обновление/удаление target, блокировка экрана и ошибка запуска переводят entry в безопасный неактивный исход. Они не меняют ON/OFF, TUN, generation, профили, правила или fallback.

Настройка: выбрать приложение → выбрать один поддержанный элемент/event → увидеть объяснение, что читает observer → локально проверить trigger → явно включить. Обычный тап исходной кнопки может выполнить её собственное действие; Waarp его не подавляет и не переписывает. «Проверить» не вооружает постоянный observer незаметно.

### 4.2. Минимальная граница данных

Хранить локально только выбранную идентичность package, совместимую версию/идентичность для повторной валидации, выбранный event type и минимальный descriptor. Текст чужого интерфейса не отправляется, не экспортируется и не попадает в журналы. Предпочитать стабильный разрешённый идентификатор; текстовое сопоставление допустимо только как явно показанный пользователю ограниченный вариант. Смена языка/версии target должна инвалидировать хрупкий descriptor, а не расширять совпадение на похожие элементы.

Observer запрашивает события только выбранного package; широкое чтение дерева, screenshots, доступ к password-полям, инъекция жестов и нажатие чужих кнопок не нужны для заявленного результата. Не добавлять capabilities «на будущее». Перед разработкой определить, достаточно ли доступного события без получения window content; если нет, результат spike обязан показать конкретную потребность и disclosure.

### 4.3. Открытие и восстановление

Открытие выполняется только документированным путём, допустимым для текущего API и foreground state. Запрет запуска не лечится скрытым overlay или обходом ОС: пользователь получает поддерживаемую явную альтернативу. Fallback — свой shortcut/tile/notification или обычный entry — отдельный режим, а не ложное выполнение исходной «липучки».

Нейтральный cover не выдаёт себя за приложение, в котором был event. Он не маскирует VPN consent, не убирает отзыв permission и не мешает удалить Waarp. До отключения обычного alias приложение требует проверить восстановительный вход. Смена alias/разрешения не вызывает импорт и не принимает внешнюю команду на изменение VPN.

## 5. ADR-STK-001: выбранный первый этап

**Дата решения:** 2026-11-21. **Решение принято:** root. **Статус ADR:** review в текущем roadmap PR. Scope выбран; повторное подтверждение владельца для этого планирования не требуется. Ни ADR, ни положительный результат prototype сами по себе не означают готовую production-функцию.

**Контекст.** Исходная цель — добровольный вызов Waarp по выбранному действию другого приложения — сохранена. Сейчас в коде нет observer/alias, а пригодность чужого accessibility event и допустимость foreground launch зависят от платформы. Зависимость исследования от неизвестного результата не должна останавливать само исследование.

**Решение: две независимые дорожки.**

1. Первый delivery slice — собственный восстанавливаемый нейтральный entry/alias (STK-002). Сначала работают обычное открытие, возврат и явное восстановление нормального входа. Только после доказанного recovery разрешается опционально скрывать обычный launcher entry. Скрытие launcher не скрывает пакет от ОС и не меняет VPN, profiles, routes, TUN или session identity.
2. Параллельно — ограниченный cross-app event spike (STK-003) на **принадлежащем проекту test app**. Target содержит обычные native controls без SDK, hook или callback для Waarp. Проверяется наблюдение штатного click/long-click event и открытие собственного UI; установленное target APK не переписывается, чужая кнопка не перехватывается и её исходное действие сохраняется. Prototype остаётся test/debug-only: production observer и новые production permissions не входят в этот этап.

**Gate перехода к observer.** Положительные воспроизводимые evidence STK-003 позволяют начать запланированный STK-004; production-поставка дополнительно требует STK-005 (невмешательство в VPN) и STK-006 (permissions, disclosure, допустимый канал). Положительный стендовый результат не доказывает поддержку всех сторонних приложений. Отрицательный результат — полноценный итог исследования `unsupported` с API, причиной и пределами; его не заменяют overlay-трюком, ловлей всех taps или обходом ОС.

**Последствия.** Нейтральный entry может быть полезной самостоятельной поставкой после своей приёмки. Shortcut/tile/notification остаются явными fallback-входами. Ни один из них не выдаётся за выполнение исходной cross-app функции. Windows companion сохраняется как текущий baseline, отдельная context panel отложена в STK-007.

**Закрытие решения.** Для STK-001 подготовлен этот конкретный ADR и установлен порядок STK-002 ∥ STK-003; карточка переходит в `review`. Реализация и положительная feasibility здесь не заявляются. После ревью ADR root может перевести только STK-001 в `done`, не закрывая автоматически остальные задачи.

## 6. Исполняемые карточки

### STK-001

- **priority:** P1 — контракт перед кодом.
- **status:** `done` — ADR-STK-001 принят и слит через [PR41](https://github.com/INNVoices/waarp/pull/41), main `217870599b3ab1913f68bade5bebf8eb44b192f8`; required CI успешен. Реализация entry и event spike — следующие отдельные задачи.
- **Dependencies:** нет.
- **files:** `docs/ANDROID-CHAMELEON-2026-11-18.md`, `docs/production/04-sticky-companion.md`; Android `AndroidManifest.xml`, `MainActivity.kt`, `WaarpApplication.kt` как evidence.
- **change:** решение зафиксировано в ADR-STK-001: сначала recovery, затем optional launcher hiding; параллельно test/debug-only cross-app event spike без модификации target APK и перехвата controls. Исходный запрос остаётся самостоятельной целью.
- **acceptance:** ADR позволяет начать STK-002/003 без повторного выбора scope владельцем; production observer закрыт gates STK-003/005/006. Документ различает fallback и cross-app trigger, сохраняет VPN-инварианты и честный отрицательный результат.
- **verification:** выполнена read-only сверка manifest/lifecycle и первичных источников; ADR подготовлен для ревью в roadmap PR. Перезапуск VPN не нужен и не выполнялся.

### STK-002

- **priority:** P1.
- **status:** `planned`
- **Dependencies:** STK-001, UX-003.
- **files:** Android `AndroidManifest.xml`, `MainActivity.kt`, UI preferences; предлагаемые `entry/EntryMode.kt`, `entry/EntryActivity.kt` и собственные alias/resources. Не редактировать engine/controller ради UI entry.
- **change:** реализовать собственный обратимый нейтральный entry с явным recovery. Сначала вход/возврат/восстановление, затем опциональное переключение launcher alias. Нейтральный дизайн не использует чужой бренд и не обещает защищённое хранилище.
- **acceptance:** свежая установка, upgrade, обычный restart, забытый жест, disabled alias и запуск из системного configure path не оставляют пользователя без управления. Нормальный entry возвращается документированным действием; OFF остаётся OFF, ON остаётся тем же сеансом.
- **verification:** до 8 UI/alias сценариев на stock emulator API 29 и текущем поддерживаемом API, плюс один заявленный OEM launcher на реальном устройстве. Отсутствующий OEM отмечается NOT_RUN; его поддержка не рекламируется.

### STK-003

- **priority:** P1 — исследовательский gate исходной функции.
- **status:** `planned` — ограниченное исследование начинается после STK-001; неизвестный результат не блокирует само исследование.
- **Dependencies:** STK-001.
- **files:** отдельный test-only Android fixture target и debug-only observer prototype; production manifest не получает AccessibilityService до результата. Итог в `docs/production/04-sticky-companion.md` или связанном коротком ADR.
- **change:** проверить одну click и одну long-click последовательность в принадлежащем проекту test app: наличие пригодного event, различение элемента, ограничения launch, Back/task восстановление, отзыв разрешения. Обычный target не содержит интеграции с Waarp; его APK не переписывается, действие кнопки не подавляется. Минимальная конфигурация без чтения всех окон; production observer не добавляется.
- **acceptance:** таблица результатов содержит API, target, тип UI, язык, event availability, способ запуска и отказ. Отрицательный результат остаётся отрицательным; нет попытки заменить его ловлей всех taps или обходом ограничений. Успех fixture не объявляет поддержку любого стороннего приложения.
- **verification:** максимум 2 детерминированных controls owned test app и 3 API (29/35/36), до 20 событий на случай. Проверить, что исходное действие control выполняется и нет новых VPN-команд. Сторонние пользовательские приложения не входят в этот spike; нет бесконечного monitoring или записи экранов.

### STK-004

- **priority:** P2 — после положительного feasibility.
- **status:** `planned` — реализация допускается после положительных evidence STK-003; до этого остаётся запланированной.
- **Dependencies:** STK-002, STK-003.
- **files:** предлагаемые Android `entry/StickyDescriptor.kt`, `entry/StickyObserver.kt`, `entry/StickySettings.kt`; preferences и manifest только разрешённого variant.
- **change:** реализовать узкий opt-in matcher, одно выбранное приложение/правило в первой версии, preview/arm/disarm, защиту от повторного события и инвалидирование descriptor. Единственный результат совпадения — запрос показать собственный UI.
- **acceptance:** чужой package, password element, stale descriptor, screen lock, отключённое разрешение и неподдерживаемое событие не открывают UI и не мутируют сеть. Двойное событие не создаёт две Activity. Журнал содержит только безопасные reason codes; текст чужого UI отсутствует.
- **verification:** таблица положительных/отрицательных matcher fixtures, 1 instrumentation flow arm → trigger → Back → revoke. Bounded event burst из 20 событий; убедиться в одном UI-open и нулевых VPN-command calls.

### STK-005

- **priority:** P1 — gate любой поставки entry режима.
- **status:** `planned`
- **Dependencies:** STK-002.

**Conditional dependencies:** STK-004.

**Dependency notes:** STK-002; STK-004 только если включён observer.
- **files:** Android `WaarpApplication.kt`, `core/VpnController.kt`, `service/WaarpVpnService.kt`, `MainActivity.kt`, существующие runtime evidence/journey tests; новые entry tests.
- **change:** подтвердить архитектурно и наблюдением, что presentation не управляет VPN. Entry module не получает полномочий start/stop/rebuild/apply; UI использует существующее явное управление.
- **acceptance:** 10 открытий/возвратов, revoke и alias toggle при ON сохраняют идентичность core/TUN и текущие маршруты без дополнительного consent; при OFF не появляется VPN-сеанс. Штатный системный Always-on остаётся отдельной причиной lifecycle transition и не приписывается entry.
- **verification:** targeted instrumentation сначала с OFF и command spies, затем один disposable ON scenario с heartbeat/session evidence. Прерывание наблюдения или отсутствующее устройство означает NOT_RUN, не успешную непрерывность.

### STK-006

- **priority:** P1 — перед публикацией observer.
- **status:** `planned`
- **Dependencies:** STK-003.

**Conditional dependencies:** STK-004.

**Dependency notes:** STK-003; STK-004 при поставке observer.
- **files:** Android manifest/build variant, disclosure UI и переводы; `docs/INSTALL.md`, `SECURITY.md`, release notes.
- **change:** определить канал распространения и задокументировать реальные permissions/data flow; включить observer только там, где завершены платформенные и channel requirements. Подготовить правдивые screens/video для review, если он требуется выбранным каналом.
- **acceptance:** permission выдаётся только пользователем; нет фиктивного `isAccessibilityTool`; описание совпадает с кодом и фактическими data accesses; default не наблюдает сторонние приложения. Не заявлять одобрение магазина до его фактического получения.
- **verification:** manifest diff, проверка disclosure до system Settings, отрицательный revoke test и ревью политики по первичным ссылкам. Не обходить restricted settings, consent или review.

### STK-007

- **priority:** P2 — optional Windows backlog, не часть обязательной Android поставки.
- **status:** `deferred` — optional Windows backlog; не блокирует исходную Android-функцию.
- **Dependencies:** STK-001, UX-004.
- **files:** существующие `src/main/bridge.ts`, `src/shared/companion.ts`, `src/main/index.ts`; только при отдельном выборе scope — новые window-context/panel modules.
- **change:** сначала переиспользовать существующий cooperative bridge; если нужен отдельный Windows сценарий, спроектировать принадлежащую Waarp панель рядом с выбранным внешним окном. Не встраивать WebContents в чужой процесс и не обещать запуск по произвольной кнопке без пригодного UI Automation event.
- **acceptance:** панель имеет собственную идентичность, не перехватывает чужие controls, не захватывает фокус самопроизвольно, скрывается при неактуальном target и корректно обрабатывает DPI/monitor change. Secure desktop/elevated target остаются вне первого scope; отсутствие доступа — объяснимый отказ. Read-only показ не вызывает `routes.ensure`.
- **verification:** только после отдельного выбора: 3 окна одного integrity level, 2 DPI, minimize/close/reuse handle и focus отказ. [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window) описывает свои parent/child окна и `showInactive`; [screen](https://www.electronjs.org/docs/latest/api/screen) — DIP; [SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook) — scoped out-of-context events; [SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow) — ограничения фокуса. [UI Automation security](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-security-overview) не даёт оснований обещать доступ к защищённому UI без специальных требований. UIAccess/UAC обходы не входят в предложение.

## 7. Решение о готовности

Можно отдельно поставить нейтральный entry, если выполнены STK-002/005 и честно указано, что cross-app trigger ещё отсутствует. Назвать исходную «липучку» готовой можно только после положительного STK-003, реализации STK-004 и необходимых STK-005/006. Если target не выдаёт пригодных событий, приложение показывает ограничение; поддерживаемый fallback остаётся полезным самостоятельным входом, но не доказательством выполнения исходного требования.
