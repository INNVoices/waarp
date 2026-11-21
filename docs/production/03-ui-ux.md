# 03. UI/UX: доведение существующих сценариев до production

**Основание:** чтение `main` на `63fc7930abfeac1b870e9c8e3fabc500768f419e`, 2026-11-21. Это аудит исходников и контрактов тестов; новый запуск Windows, Android, TalkBack или Narrator в этом проходе не выполнялся. Исторические screenshots и CI не считаются проверкой нового head. Статус задачи ниже относится к её реализации/ревью, а не к выпуску продукта.

## 1. Продуктовый результат и существующая основа

Пользователь должен понимать выбранный путь, фактически применённый путь, причину отказа и следующий доступный шаг. Импорт, выбор маршрута, включение VPN и открытие интерфейса остаются разными действиями. Сохраняем текущую архитектуру и исправляем конкретные препятствия; массовый редизайн не является условием production.

| Сценарий | Windows: фактическая точка входа | Android: фактическая точка входа | Что сохраняем |
| --- | --- | --- | --- |
| Первый запуск / открыть и закрыть VPN | `src/renderer/src/App.tsx`, `pages/connections.tsx`, `lib/master.ts` | `ui/WaarpApp.kt`, `ui/HomeRoutes.kt`, `MainActivity.kt` | Авторитетный runtime status отдельно от немедленной реакции кнопки; системное VPN-согласие |
| Маршрут приложения / сервиса / адреса | `pages/library.tsx`, `pages/route.tsx`, `pages/server-picker.tsx` | `ui/HomeRoutes.kt`, `ui/UiComponents.kt` | Черновик, сохранение, применение и live evidence различимы |
| Личные подключения и публичный каталог | `pages/servers.tsx`, `pages/addtunnel.tsx`, `pages/publiccat.tsx` | `ui/TunnelsScreen.kt`, `ui/TunnelDialogs.kt` | Добавление публичного узла явно; ограничения защищённых маршрутов остаются |
| Диагностика и экспорт | `pages/analyzer.tsx`, `pages/payload-check.tsx`, `pages/settings.tsx` | `ui/DiagnosticsSettings.kt`, `ConnectionCheckSharing.kt` | Неизмеренное не превращается в успех; отчёт и экспорт конфигурации различаются |
| Настройки и восстановление | `pages/settings.tsx`, `src/main/index.ts` | `ui/DiagnosticsSettings.kt`, `MainActivity.kt` | Восстановление, обычный показ окна и явный ON/OFF не смешиваются |

Префикс Android-файлов в таблице и карточках: `android/app/src/main/java/local/waarp/android/`.

**Уже есть в коде:** четыре основных раздела и отдельные настройки; Windows `Modal` с удержанием/восстановлением фокуса, обработкой Escape и busy; видимый focus, reduced motion и forced colors в CSS; минимальное окно 900 × 600 и сохранение bounds с проверкой дисплеев; Android `rememberSaveableStateHolder`, нижняя навигация/rail от 840 dp, сохранение состояния разделов, `FormSheet` с IME padding и отдельной областью Snackbar. Это нужно сохранить, а не реализовывать повторно. Источники: [App](../../src/renderer/src/App.tsx), [Modal](../../src/renderer/src/ui/modal.tsx), [styles](../../src/renderer/src/styles.css), [createWindow](../../src/main/index.ts), [WaarpApp](../../android/app/src/main/java/local/waarp/android/ui/WaarpApp.kt), [FormSheet](../../android/app/src/main/java/local/waarp/android/ui/HomeRoutes.kt).

## 2. Подтверждённые пробелы и границы вывода

| Наблюдение в коде | Практический вывод | Степень подтверждения |
| --- | --- | --- |
| В `ListsPanel` две icon-only `Btn` получают `title`, но не `aria-label`. `Btn` снимает `title` и передаёт его только в `Tooltip`; `Icon` имеет `aria-hidden`; Tooltip добавляет описание, а не имя | У действий обновления/удаления нет явного доступного имени. Исправление UX-001 ограничено двумя кнопками | Дефект прослеживается по исходникам; адресная DOM-проверка — часть исправления |
| `createWindow()` задаёт `minWidth: 900, minHeight: 600`; bounds проверяются на частичное пересечение с workArea | Малый логический workArea при высоком DPI требует отдельной проверки; браузерный viewport не доказывает native DPI usability | Риск из кода, обрезание конкретного устройства не наблюдалось |
| Общий Android `ActionButton` использует `height(50.dp)`, часть destructive rows — `height(48.dp)`; другие элементы уже используют `heightIn` | Проверить длинные переводы и большой шрифт, затем исправить только доказанные места обрезания | Фиксированная высота подтверждена; clipping не объявляется измеренным |
| Windows выставляет RTL, но CSS содержит физические `left/right`, а Tooltip `side='right'` не меняется по направлению | Нужен проход по направлению и геометрии, не только проверка `document.dir` | Кандидаты на дефекты; фактический экран проверяется в L10N-005 |
| Имеются хорошие браузерные проверки focus/overflow и Android проверки форм/состояния | Их следует расширять под конкретный риск; они не заменяют native screen-reader и OS permission проверки | Контракты прочитаны, в этом аудите не перезапускались |

## 3. Неподвижные UX-контракты

- Открытие, сворачивание, смена языка, возврат из стороннего приложения и изменение размеров не дают команд VPN, не выбирают другой профиль и не создают второй engine.
- У операций есть отдельные состояния: доступна → выполняется → результат. Повторное нажатие не запускает вторую мутацию; отмена не притворяется rollback, если backend уже сохранил изменение.
- «Сохранено», «применено», «проверено» и «работает сейчас» имеют разный смысл. UI отображает существующие DTO, не выводит успех из отсутствия exception.
- Ошибка остаётся рядом с действием или доступна повторно. Snackbar не закрывает последний control, не прыгает вместе с формой и не является единственным способом узнать постоянную проблему.
- Диагностика объясняет, что и когда проверено, и что осталось неизвестным. Публичный сервер не получает недоказанную метку безопасности.
- Визуальная карта дополняет список. Выбор страны, серверов и действий доступен без точного указателя, цвета или понимания карты.

## 4. Исполняемые карточки

### UX-001

- **priority:** P1 — первая узкая коррекция.
- **status:** `done` — PR31 слит после успешного общего Windows CI; protected behavior сохранено.
- **Dependencies:** нет.
- **files:** `src/renderer/src/pages/settings.tsx` (`ListsPanel`); доказательство: `src/renderer/src/ui/kit.tsx` (`Btn`, `Icon`), `ui/tooltip.tsx`; существующий renderer fixture.
- **change:** добавить явные `aria-label={s('lists.refresh')}` и `aria-label={s('set.remove')}` к двум icon-only кнопкам. Использовать имеющиеся переводы; сохранить title/Tooltip, disabled и handlers. Не менять глобально семантику всех `Btn`.
- **acceptance:** обе кнопки находятся по роли и имени до hover/focus; доступны с клавиатуры при разрешённом действии; disabled удаление остаётся disabled; подсказка причины недоступности не исчезает. Маршрутизация и IPC-вызовы не меняются.
- **verification:** один адресный renderer/DOM сценарий с одним неиспользуемым и одним используемым списком, RU и EN; проверка role/name, состояния disabled и tooltip. Сценарий добавлен в существующий `test/ui.browser.mjs`, локально проверен синтаксис; runtime browser результат ожидается от CI, его прохождение здесь не заявляется. `git diff --check` выполнен. Полная Android/Windows runtime matrix не нужна для изменения двух атрибутов. Финальный результат PR31: typecheck, unit suites, browser UI, native lifecycle, package verification и общий CI успешны; PR слит как 0e2a23b17dd5e89609917beed3f5b1a2d563021b.

### UX-002

- **priority:** P1.
- **status:** `ready`
- **Dependencies:** UX-001.
- **files:** `src/renderer/src/App.tsx`, `ui/kit.tsx`, `ui/modal.tsx`, `ui/tooltip.tsx`, `pages/route.tsx`; Android `ui/UiComponents.kt`, `ui/HomeRoutes.kt`, `ui/AtlasMap.kt`; `test/ui.browser.mjs`, Android `MobileUiInstrumentedTest.kt`.
- **change:** составить опись доступных имён и ролей именно интерактивных элементов; проверить selected navigation, порядок Tab, возврат фокуса, имя формы, связь ошибки с полем и семантику карты/списка. Исправлять подтверждённые пропуски малыми PR. Декоративным иконкам не добавлять дублирующие описания.
- **acceptance:** четыре раздела, настройки, импорт, route picker и удаление выполняются клавиатурой; диалог не выпускает фокус и возвращает его в существующий инициатор; у выключенного действия понятна причина; Android label/role/state читаются единым осмысленным control, а не несколькими дубликатами.
- **verification:** не более 8 ключевых последовательностей в browser fixture; один проход Narrator и один TalkBack на заявленных средах с журналом конкретных проблем. Compose semantics tests проверяют роль/состояние, но не объявляются полной проверкой озвучивания. Первичный ориентир: [Compose semantics](https://developer.android.com/develop/ui/compose/accessibility/semantics).

### UX-003

- **priority:** P1.
- **status:** `ready`
- **Dependencies:** нет.
- **files:** `src/renderer/src/lib/master.ts`, `lib/actions.ts`, `App.tsx`, `pages/addtunnel.tsx`, `pages/route.tsx`; Android `ui/MobileUiState.kt`, `ui/UiComponents.kt`, `ui/HomeRoutes.kt`, `MainActivity.kt`.
- **change:** закрепить таблицу состояний для первого запуска, пустой библиотеки, импорта, ON/OFF, сохранения маршрута и восстановления. Сопоставить каждый видимый текст/CTA с реальным полем backend: pending, saved, applied, blocked, stale, error. Не вводить второй UI-автомат VPN.
- **acceptance:** у каждой операции есть понятный успешный исход, отказ и безопасный следующий шаг; ошибка записи сохраняет черновик; устаревший ответ не перетирает новый выбор; работающий туннель не выглядит отключённым только из-за скрытого окна; пользователь видит различие отсутствия измерения и нулевого значения.
- **verification:** 6 детерминированных fixture-сценариев: initial failure/retry, invalid import, deferred mutation, failed save, stale response, recoverable runtime error. Реальный VPN-прогон требуется только при изменении mapping runtime state или control plane.

### UX-004

- **priority:** P1.
- **status:** `planned`
- **Dependencies:** UX-003.
- **files:** `src/main/index.ts` (`createWindow`, bounds), `src/renderer/src/layout.css`, `styles.css`, `ui/modal.tsx`, `ui/tooltip.tsx`, `test/ui.browser.mjs`.
- **change:** определить поддерживаемый минимальный логический workArea и контракт масштабирования. Проверить экран при Windows DPI 100/150/200%, смене монитора и восстановлении окна; при доказанном обрезании согласовать минимальный размер окна с responsive layout и workArea. Не считать DPR browser context заменой native DPI.
- **acceptance:** системные кнопки, главное действие, последний control формы и сообщение ошибки доступны без вынужденного изменения системного масштаба; off-screen bounds восстанавливаются; длинный текст переносится; внутренний скролл остаётся у длинного списка, а не скрывает основное действие. Tooltip не выходит за workArea.
- **verification:** 900 × 600 и уменьшенный согласованный viewport в renderer; один native Windows проход 100/150/200% с двумя дисплеями либо честный NOT_RUN для отсутствующего устройства. 6 screenshots максимум на изменение. Источник: [Electron screen: DIP и изменения дисплеев](https://www.electronjs.org/docs/latest/api/screen).

### UX-005

- **priority:** P1.
- **status:** `planned`
- **Dependencies:** UX-003.
- **files:** Android `ui/UiComponents.kt` (`ActionButton`), `ui/HomeRoutes.kt` (`FormSheet`, destructive actions), `ui/WaarpApp.kt`, `ui/TunnelDialogs.kt`; `OperationFeedbackInstrumentedTest.kt`.
- **change:** адресно проверить фиксированные высоты и итоговые действия с большим шрифтом, IME, длинной ошибкой и translation expansion. При воспроизводимом clipping заменить фиксированную высоту минимальной с корректным переносом, сохраняя touch target и позицию формы.
- **acceptance:** на 360 dp и 840 dp при fontScale 1.0/1.5/2.0 читается подпись и доступно действие; клавиатура не закрывает Save/Cancel; Back не теряет несохранённый черновик незаметно; Snackbar не перекрывает controls. Это критерии будущей проверки, не утверждение о текущем результате.
- **verification:** расширить существующий тест формы только затронутым случаем; один portrait/landscape или split-screen сценарий на поддерживаемом Android. Не перезапускать native VPN protocol matrix из-за изменения высоты кнопки.

### UX-006

- **priority:** P1.
- **status:** `planned`
- **Dependencies:** UX-003.
- **files:** `pages/connections.tsx`, `pages/addtunnel.tsx`, `pages/server-picker.tsx`, `src/shared/strings/`; Android `ui/HomeRoutes.kt`, `ui/TunnelsScreen.kt`, `ui/TunnelDialogs.kt`; `docs/INSTALL.md`.
- **change:** довести первый полезный сценарий: добавить собственное подключение → выбрать область маршрутизации → явным действием открыть VPN → увидеть результат и способ отключения. Согласовать термины приложения, инструкции и ошибки. Публичный каталог — отдельный осознанный выбор, не скрытый резерв onboarding.
- **acceptance:** новый пользователь различает клиент и VPN-провайдера; видит требования к своему профилю; отказ системного согласия и отсутствие сети объяснены; повторный импорт/возврат не дублирует профиль; ранее успешный импорт не теряется при последующей ошибке проверки.
- **verification:** 3 прохода на fixtures: собственный профиль, ошибочный импорт, отказ разрешения. Один реальный smoke только перед release и только с тестовым профилем без публикации секретов.

### UX-007

- **priority:** P1.
- **status:** `planned`
- **Dependencies:** UX-003.
- **files:** `pages/analyzer.tsx`, `pages/payload-check.tsx`, `pages/settings.tsx`, `src/main/index.ts` (diagnostic history IPC); Android `ui/DiagnosticsSettings.kt`, `ConnectionCheckSharing.kt`; актуальный exporter из `MainActivity.kt`.
- **change:** оформить диагноз как наблюдение, время и границу уверенности; рядом дать одно подходящее действие. До экспорта ясно назвать содержимое и различие с полным конфигом. Не выводить технические секреты в toast и не отправлять данные автоматически.
- **acceptance:** timeout не объявляется доказанной блокировкой; DNS/TCP/TLS/payload и выбранный/применённый путь различимы; незапущенная проверка видна как незапущенная; пользователь понимает, куда передаёт отчёт; отсутствие dev mode не скрывает сведения, нужные для обычного выбора пути.
- **verification:** 4 подготовленных результата: pass, failure, not measured, stale; snapshot текста и проверка экспортируемого fixture на известные секреты. Сетевой interop не нужен при редактировании представления готового результата.

### UX-008

- **priority:** P1 — завершение UI-этапа.
- **status:** `planned`
- **Dependencies:** UX-001, UX-002, UX-004, UX-005, L10N-005.
- **files:** `test/ui.browser.mjs`, `scripts/test-ui.mjs`, Android UI instrumentation tests; `docs/production/03-ui-ux.md`, release evidence по фактическому head.
- **change:** собрать ограниченную матрицу приёмки интерфейса с разделением browser fixture, Android Compose, native desktop и ручной screen-reader проверки. Сохранить существующие reduced-motion/forced-colors режимы и измерить контраст текста/границ после фактических цветовых изменений.
- **acceptance:** отчёт содержит SHA, платформу, viewport/scale, locale, выполненные сценарии, артефакты и NOT_RUN. Нет заявления «весь UI доступен» на основании единственного `dir=rtl` или чистого screenshot. Проверка относится к собранному артефакту, не только к исходникам.
- **verification:** обязательный компактный набор — импорт, route change, busy/error, settings, recover; RU/EN плюс один длинный LTR, один RTL и один CJK язык. Полная 19-языковая визуальная матрица запускается только для регрессии каталога/общей типографики, а не каждого CSS-изменения.

## 5. Порядок исполнения и доказательства

Начать с UX-001 и L10N-001 отдельным небольшим PR. Затем UX-003 задаёт общие состояния; UX-002/004/005 могут идти параллельно при раздельном владении файлами. UX-006/007 опираются на эти контракты. UX-008 закрывает только UI-часть готовности; production signing, VPN runtime, update/uninstall и provenance проверяются отдельными release gates.

Перед PR агент указывает: ID, точные изменённые файлы, наблюдаемый дефект, выполненную адресную проверку, ограничения. Не добавляет массовые snapshots, новые UI-библиотеки или новый тестовый framework без конкретной необходимости. Старые подробные исследования остаются источником контекста: [UI stability](../UI-STABILITY-2026-11-16.md), [UX integration](../planning/WAARP-NEXT-2026-11-18/02-UX-INTEGRATION.md), [TUN/UI ownership](../TUN-OWNERSHIP-AND-UI-2026-11-18.md).
