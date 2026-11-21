# 07. Дистрибуция, первый запуск и продвижение

Цель — довести человека от точного описания Waarp до проверенного первого маршрута, затем расширять доступность через подходящие каналы. Работа по продвижению продолжается на собственных страницах и в документации, пока production-сборки проходят инженерную приёмку. Новая заявка в каталог сама по себе не считается результатом использования продукта.

**Срез: 21 ноября 2026 года, исходники `63fc7930abfeac1b870e9c8e3fabc500768f419e`.** Ниже разделены существующие результаты, выполняемый контент и ещё не выполненные задачи. Статусы задач: `ready` — можно начинать, `planned` — спецификация готова, зависимости ещё не закрыты, `in_progress` — есть работа для review, `blocked` — указано конкретное недостающее условие. Приоритет P0 останавливает production-выпуск; P1 делает выпуск или первый запуск пригодным; P2 расширяет распространение после выполнения предпосылок.

## Исходное состояние и границы утверждений

| Область | Подтверждённое состояние | Следствие для распространения |
| --- | --- | --- |
| Windows | Публичный r6: `0.4.1-rc.5`, x64 portable EXE без подписи издателя | Прямую preview-загрузку можно описывать с её ограничениями; не называть её production 1.0.0 |
| Android | Публичный r5: `0.5.0-rc.5`, три отдельных debug APK, `local.waarp.android.debug` | Preview не обновляет production-пакет `local.waarp.android`; последний Windows-релиз не содержит APK |
| Текущий `main` | General CI [44831610520](https://github.com/INNVoices/waarp/actions/runs/44831610520) успешен; Android [44831610512](https://github.com/INNVoices/waarp/actions/runs/44831610512) завершился с отказами, 2-часовой soak пропущен | Нельзя объявлять полную Android-приёмку или выпуск нового APK. Точный свежий кандидат принимается по REL-004…REL-008 |
| Подготовка доставки | Опубликованы INSTALL, собственный Obtainium import, кандидат Scoop, EN/RU Fastlane | Obtainium не испытан на устройстве; Scoop не прошёл install/update/uninstall; metadata не означает принятие магазином |
| Позиционирование | Windows — Apache-2.0; Android — GPL-3.0-or-later; сторонние компоненты имеют отдельные notices | Не подставлять одну лицензию для всего репозитория в форму каталога |
| GitHub discoverability | На момент проверки About/website/topics пусты; 0 stars | Можно подготовить точные поля; нельзя считать невыполненные пороги каталогов пройденными |

Источники состояния: [публичные releases](https://github.com/INNVoices/waarp/releases), [INSTALL](../INSTALL.md), [release record](../RELEASES.md), [distribution files](../distribution/README.md), [Fastlane metadata](../../fastlane/README.md), [production APK issue #25](https://github.com/INNVoices/waarp/issues/25), [repository API](https://api.github.com/repos/INNVoices/waarp). Повторная проверка перед запуском обязательна: эта таблица — датированный срез, а не автоматически обновляемая панель.

Waarp описывается как **open-source VPN/proxy routing client for Windows and Android** с личными профилями и правилами приложений/доменов. Не обещать собственную сеть VPN-серверов, независимый аудит безопасности, анонимность, отсутствие всех утечек, ускорение игр или доступность любого публичного узла. Открытые исходники позволяют проверить реализацию, но не заменяют такой аудит. Одноимённый [Waarp MFT](https://waarp.github.io/Waarp/About.html) — другой проект; использовать платформы, назначение и ссылку `INNVoices/waarp` для различения, сохраняя существующее имя и бренд.

## Реальные заявки и очередь каналов

Повторно проверены только доступные публичные страницы и ранее открытая nomination. Повторных отправок в этом проходе нет.

| Канал | Статус на срезе | Следующее допустимое действие |
| --- | --- | --- |
| [lgg/awesome-vpn #12](https://github.com/lgg/awesome-vpn/issues/12) | Открыта, комментариев нет; в проверенном [CLIENTS.md](https://github.com/lgg/awesome-vpn/blob/master/CLIENTS.md) Waarp не найден | Дождаться ответа; на конкретный запрос дать факты. Не создавать дубликат и не писать пустой bump |
| OpenSourceDex | Предыдущая форма приняла заявку; карточка не подтверждена в [Networking](https://opensourcedex.com/category/networking-connectivity) и [Security](https://opensourcedex.com/category/security-privacy) | Проверить следующую реальную публикацию. Отсутствие на этих страницах не доказывает отказ или отсутствие во всём каталоге |
| [Android Weekly](https://androidweekly.net/) | Заявка ранее принята формой; последний проверенный выпуск №753 от 15.11.2026 предшествует подаче | Проверить следующий опубликованный выпуск; не ставить featured-бейдж без включения |
| [Kotlin Weekly](https://kotlinweekly.net/) | Заявка ранее принята формой; последний проверенный выпуск №537 от 15.11.2026 предшествует подаче | Проверить новый выпуск; не повторять тот же URL |
| Собственные README/Pages/guide | Существуют README, установка и RU/EN Pages; новый guide в GROW-001 находится на review | Опубликовать полезный контент через обычный PR и проверить ссылки после deploy |
| IndexNow / архивирование | Уведомление IndexNow было принято HTTP 202; Software Heritage сохранил снимок | Отмечать уведомление и архив отдельно от индексации, упоминания или пользовательского трафика |

**Закрытая очередь этого прохода.** Не повторять прежние 403 для OpenAPK, HelloGitHub, ruanyf/weekly, AndroidFossApps, freeVpnMan, LibHunt, OpenSourceChoice и ecosyste.ms; не повторять 502 AwesomeF/OSS и уже использованную попытку/предложенный retry FindOpenSources.com. It’s FOSS ничего не получил: сервер отклонил форму без обязательного email. Новая попытка возможна только при реальном изменении доступа/условий и разрешённом канале; подмена email, аккаунта, источника или обход защиты не решают задачу. Эти ограничения не означают редакционный отказ от проекта.

Login-only площадки остаются отдельной очередью с конкретным действием владельца, а не местом бесконечного поиска анонимного обхода. Для площадок с запретом AI-промотекстов агент готовит только факты и доказательства; самостоятельное авторство и обсуждение остаются человеку. [HN](https://news.ycombinator.com/newsguidelines.html), [Хабр](https://habr.com/ru/docs/help/rules/) и [DEV](https://dev.to/guidelines-for-ai-assisted-articles-on-dev/) проверяются перед конкретным использованием, не получают автоматический дублированный анонс.

## Порядок исполнения

1. **Сейчас:** GROW-001 → review и публикация инструкции; GROW-002 — небольшой воспроизводимый опыт первого запуска; GROW-004 и GROW-007 — обратная связь и исходные измерения. GROW-003 подготавливает поля GitHub, GROW-005 проверяет поступившие решения без повторной подачи.
2. **До production:** DIST-001 сводит точные сведения о файлах; REL-004…REL-008 дают приёмку, подпись, установку и публикацию. Android и Windows сохраняют собственные версии, доказательства и ограничения. Мерж инженерного PR не открывает этот этап автоматически.
3. **После пригодной поставки:** Windows DIST-002 → DIST-003; Android DIST-004. Честный локальный install/update test предшествует отправке manifest/config в чужой репозиторий.
4. **При выполнении отдельных правил:** DIST-005/006 → рассмотрение F-Droid/IzzyOnDroid. GROW-006 выполняет один подходящий адресный запуск, затем собирает обратную связь. Приём каталогом не является условием поддержки прямых официальных загрузок.

## Задачи дистрибуции

### DIST-001

**Название:** Единый проверяемый каталог официальных сборок. **Priority:** P1. **Status:** `planned`. **Owner:** distribution agent + release reviewer. **Dependencies:** BLD-001.

**Conditional dependencies:** REL-008.

**Dependency notes:** BLD-001; изменение production-указателей только после REL-008.

**Files:** `docs/distribution/releases.json` (новый), `docs/distribution/README.md`, `docs/INSTALL.md`, `docs/RELEASES.md`; README и Pages — согласованный handoff их владельцу. Не менять workflow подписи или существующие бинарные assets.

**Change:** собрать небольшой валидируемый manifest с platform, channel, tag, binary version, source commit, package ID/ABI, asset name/URL, size bytes, SHA-256, signing mode и ссылкой на evidence. Значение неизвестного поля — `null` с причиной, а не догадка. Внести только публичные `draft:false` releases. Разделить Windows r6 и Android r5; не выбирать `/releases/latest` для поиска APK в смешанном репозитории. Для будущего production использовать exact accepted assets из REL, не заново собранные похожие файлы. Указать дату проверки и явную связь каждой кнопки загрузки с записью manifest. Проверка целостности по SHA не называется проверкой издателя.

**Acceptance:** каждый публичный download/Obtainium/Scoop/WinGet pointer соответствует записи; версия извлечённого бинарного файла и метаданные совпадают; отсутствуют draft URLs, production label на debug APK и ложное равенство `main` версии бинарника; сохранены разные лицензии и dependency notices. Переход на production меняет только подтверждённую платформу/канал и не теряет preview-историю.

**Verification:** JSON schema/required-field validation, release API snapshot и сверка digest/size; скачать нужный файл один раз в рабочую папку и вычислить SHA-256, если идентичный проверенный файл ещё не доступен; проверить UI-ссылки после deployment. Сохранить UTC receipt и хеш manifest. При несовпадении не обновлять public pointer.

### DIST-002

**Название:** Проверить кандидат Scoop на реальном Windows. **Priority:** P2. **Status:** `blocked` — нет выполненной install/update/uninstall приёмки manifest. **Owner:** Windows distribution agent. **Dependencies:** DIST-001, REL-007.

**Conditional dependencies:** REL-008.

**Dependency notes:** DIST-001, REL-007; для production-записи REL-008.

**Files:** `docs/distribution/waarp-preview.json`, будущий `docs/distribution/waarp.json` только для настоящего production-канала, `docs/distribution/README.md`, отдельный evidence report. Пакетный runtime приложения вне scope.

**Change:** проверить manifest текущей схемой Scoop; на disposable Windows 10/11 x64 установить его из локального файла, проверить ярлык, запуск verified EXE, запрос elevation для TUN, OFF/выход, повторный запуск. Установить, где Electron и portable wrapper фактически хранят настройки: название portable не доказывает хранение рядом с EXE. Проверить обновление и uninstall с ожидаемым сохранением пользовательских профилей; не добавлять `persist`, пока реальный путь не доказан. Использовать два реально доступных совместимых выпуска для update; если их нет, отметить этот gate как не выполненный. Для upstream-готовности добавить проверяемые `checkver`/`autoupdate`, которые выбирают Windows asset нужного канала и не захватывают APK или непроверенный preview.

**Acceptance:** есть Windows transcript с версиями OS/Scoop, hash EXE, местом данных, результатами install/replacement/uninstall и отсутствием уничтожения чужих файлов; evidence совпадает с конкретным manifest. Ни наличие JSON, ни успешный статический lint не называются install test. Существующий preview manifest сохраняет честный статус до этого результата.

**Verification:** стандартные schema/bucket checks Scoop; реальный `scoop install <local-manifest-path>` и lifecycle с синтетическими профилями без чужих секретов. Для чужого bucket сначала проверить дубликаты, открыть обоснованный issue и дождаться решения maintainer, затем узкий PR и `/verify`, как требует [официальный contribution process](https://github.com/ScoopInstaller/.github/blob/main/.github/CONTRIBUTING.md). Если внешняя интеграция даёт 403, сохранить готовый diff и остановить отправку.

### DIST-003

**Название:** Подготовить проверенный WinGet package. **Priority:** P2. **Status:** `blocked` — тип/жизненный цикл установленного продукта ещё не подтверждены WinGet test. **Owner:** Windows distribution agent. **Dependencies:** DIST-001, REL-007, REL-008.

**Dependency notes:** DIST-001, REL-007, REL-008; результаты DIST-002 можно переиспользовать, но они не заменяют WinGet test.

**Files:** `docs/distribution/winget/` для подготовленного multi-file manifest и README о статусе; затем, отдельным разрешённым действием, manifests-only PR в `microsoft/winget-pkgs`. Не менять чужую документацию в package PR.

**Change:** определить по реальному EXE и текущей схеме правильный InstallerType, architecture, install scope, identifiers и unattended behavior. Не записывать самораспаковывающийся EXE как MSI/NSIS по предположению. Создать отдельные version/installer/defaultLocale YAML, schema headers и поля текущей schema version; URL строго official/version-specific, hash от exact asset. Описать elevation при запуске TUN отдельно от unattended установки. Подпись/репутация проверяются и раскрываются; unsigned сам по себе не объявляется универсальным запретом WinGet, решение зависит от действующих правил/сканирования.

**Acceptance:** локальная validation и unattended установка пройдены; launch, upgrade, uninstall и сохранность данных проверены; нет дублирующего PackageIdentifier/version PR; package имеет точные лицензии, homepage и release notes. Сканер или policy failure не обходится переименованием asset. Если Microsoft запросит CLA, соглашение выполняет сам contributor через официальный процесс — агент не принимает его от имени владельца.

**Verification:** `winget validate --manifest <folder>`; `winget install --manifest <folder>` на disposable Windows с разрешёнными LocalManifestFiles либо официальный SandboxTest; реальные exit codes/installed identity/файлы. Приложить отчёт и следовать [FirstContribution](https://github.com/microsoft/winget-pkgs/blob/master/doc/FirstContribution.md), [Policies](https://github.com/microsoft/winget-pkgs/blob/master/doc/Policies.md), [manifest reference](https://learn.microsoft.com/en-us/windows/package-manager/package/manifest). Не обещать приём после одного local pass.

### DIST-004

**Название:** Проверить Obtainium и разделить preview/production обновления. **Priority:** P1. **Status:** `blocked` — импорт/обновление пока не испытаны на устройстве. **Owner:** Android distribution agent. **Dependencies:** DIST-001.

**Conditional dependencies:** REL-005, REL-006, REL-008.

**Dependency notes:** DIST-001; production-ветка зависит от REL-005, REL-006, REL-008. Проверку существующего preview можно выполнить раньше.

**Files:** `docs/distribution/obtainium.json`, `docs/distribution/obtainium-link.txt`, `docs/distribution/README.md`, будущая отдельная production config; соответствующие блоки `docs/INSTALL.md` и Pages по handoff.

**Change:** сохранить debug identity `local.waarp.android.debug`, фильтр APK/ABI, prerelease и fallback на старший релиз с подходящим Android asset; проверить, что Windows-only r6 пропускается и выбирается r5. На реальном Android с указанной версией Obtainium импортировать JSON/URI и manual fallback, проверить выбранный APK, package, signing certificate и пользовательское подтверждение установки. Для production после REL добавить отдельную конфигурацию с `local.waarp.android`, точным фильтром release APK и тем же retained certificate. Не разрешать silent package-id change и не заменять debug config production-ссылкой. Проверка update требует реальных совместимых версий, а не изменения номера в metadata.

**Acceptance:** сохранён device receipt для import, architecture selection, install, refresh/no-update и, когда есть соответствующий релиз, update; не происходит downgrade, выбора Windows asset, APK другой ABI или смены signing identity. Не проверенный update остаётся явно не проверенным. Инструкция содержит fallback и не обещает установку без подтверждения.

**Verification:** повторить сценарий на поддерживаемой ABI/Android версии, сверить package/certificate/хеш файла до установки и после; проанализировать текущую upstream семантику [Obtainium docs](https://wiki.obtainium.imranr.dev/) и [source](https://github.com/ImranR98/Obtainium). Собственный import не требует размещения в центральном каталоге. Его [APP_CRITERIA](https://github.com/ImranR98/apps.obtainium.imranr.dev/blob/main/APP_CRITERIA.md) и [CONTRIBUTING](https://github.com/ImranR98/apps.obtainium.imranr.dev/blob/main/CONTRIBUTING.md) сейчас требуют не менее 35 stars и 4 месяцев истории источника: при 0 stars и создании repo 05.10.2026 туда не подавать и не подменять GitHub источником без счётчика.

### DIST-005

**Название:** Установить реальную готовность F-Droid. **Priority:** P2. **Status:** `blocked` — источник/recipe native dependencies и maturity ещё не приняты. **Owner:** supply-chain agent + Android distribution reviewer. **Dependencies:** BLD-003, BLD-005, REL-004.

**Conditional dependencies:** REL-005, REL-006.

**Dependency notes:** BLD-003, BLD-005, REL-004; новое подписание/совместимость каналов согласуются с REL-005/006, не заменяются этой задачей.

**Files:** `android/native-source.json`, лицензии и native build scripts — только узкие согласованные изменения владельца BLD; кандидат metadata/recipe в `docs/distribution/fdroid/`; существующий `fastlane/`.

**Change:** составить замкнутый список исходников/лицензий/инструментов каждого включённого native компонента; отдельно выяснить происхождение и сборку найденной pinned `libcronet.a`. Прогнать предлагаемую сборку в совместимом с F-Droid окружении из публичных входов; не считать наличие Go source достаточным, если итог включает необъяснённый prebuilt. Проверить историю активной разработки и реальные основания исключения из обычных трёх месяцев, если такие существуют. Разобрать package ID, anti-features и модель подписи: F-Droid собственная подпись либо подтверждённые reproducible developer-signed builds имеют разные пути обновления.

**Acceptance:** проверяемый recipe строит функциональный APK из допустимых входов, source/license scan не имеет необъяснённых бинарных зависимостей; критерий истории выполнен либо maintainer явно принял реальное исключение; пользователю объяснено, какие каналы могут обновлять друг друга. Для подачи используется официальный request-for-packaging процесс один раз, после проверки дубликатов. Перенос ключа/пакета только ради листинга запрещён.

**Verification:** сохранить полный clean-build log, lock inputs/hashes, APK/package/certificate report и список остающихся вопросов. Основные [Inclusion Policy](https://f-droid.org/docs/Inclusion_Policy/) требуют FLOSS/build transparency и обычно три месяца активной разработки; [Reproducible Builds](https://f-droid.org/docs/Reproducible_Builds/) определяет отдельный путь для подписи разработчика. Дата создания repo сама по себе не доказывает ни полную историю разработки, ни наличие пользователей. До выполнения gates поддерживать официальные прямые APK/Obtainium.

### DIST-006

**Название:** Подготовить пригодные Android listing assets и оценить IzzyOnDroid. **Priority:** P2. **Status:** `blocked` — debug APK, размер и code-provenance не соответствуют подтверждённому пути подачи. **Owner:** Android distribution + evidence/UX agents. **Dependencies:** BLD-003, BLD-004, REL-005, REL-006, REL-008.

**Dependency notes:** BLD-003/004, REL-005/006/008; новые реальные screenshot captures от UX.

**Files:** `fastlane/metadata/android/en-US/`, `ru-RU/`, `fastlane/README.md`, источник реальных screenshots/provenance. Не менять brand identity и лицензии.

**Change:** поддерживать описания в соответствии с реальным выпущенным APK. Для следующего подходящего релиза снять новые реальные кадры на допустимом viewport; тексты/UI на кадрах должны совпадать с locale либо явно раскрывать отличие. Не растягивать существующие evidence images ради лимита. Добавить changelog только для опубликованного versionCode. Проверить release key, отсутствие debuggable/testOnly и измеренный размер каждого APK; уменьшение размера идёт через BLD без удаления необходимых протоколов/лицензий наугад. Отдельно правдиво описать происхождение кода относительно текущей AI-policy площадки: metadata на LLM допустима, сгенерированный app code — самостоятельное препятствие, не устраняемое перефразированием README.

**Acceptance:** UTF-8 тексты/лимиты и image validator пройдены; все кадры имеют настоящую provenance; описание не опережает release. Для IzzyOnDroid есть доказанное соответствие либо явный итог «не подходит» с причиной. Текущие 151–168 MB debug APK не объявляются соответствующими обычным release-key/no-debug и примерно 30 MB правилам; исключение по размеру может дать только каталог. Заявка не отправляется при нерешённой несовместимости AI-policy.

**Verification:** пересчитать длины/PNG dimensions и хеши, сравнить package/certificate/flags/size с actual APK; проверить актуальные [Izzy inclusion rules](https://izzyondroid.org/docs/general/AppInclusionPolicy/), [Fastlane guidance](https://izzyondroid.org/docs/general/Fastlane/), [F-Droid metadata format](https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/). Пригодность source metadata не означает приём каталогом. Google Play и другие магазины с аккаунтом/договорами остаются отдельным решением владельца после готового APK, а не обязательным блокером прямой дистрибуции.

## Задачи первого запуска и роста

### GROW-001

**Название:** Опубликовать практическое руководство первого маршрута. **Priority:** P1. **Status:** `done` — source review завершён; руководство опубликовано через [PR41](https://github.com/INNVoices/waarp/pull/41), main `217870599b3ab1913f68bade5bebf8eb44b192f8`. Это принятие текста, а не выполненные физические сценарии GROW-002. **Owner:** documentation/growth agent. **Dependencies:** нет.

**Dependency notes:** нет production-зависимости.

**Files:** [`docs/guides/first-routes.md`](../guides/first-routes.md); ссылки из документации/Pages добавляет их владелец после review. Исходный runtime не меняется.

**Change:** написаны последовательные сценарии Windows и Android: личный профиль → одно приложение → новый запрос → явный Direct-контроль → отдельный доменный маршрут после выключения правила приложения → OFF. Подписи и приоритеты сверены с r6/r5 source. Включены различия ON/HTTP response/наблюдаемого пути, ABI/signature, общей DNS/UID на Android, ограничения публичных узлов и существующий sanitized issue intake. Указаны точные preview версии и отсутствие публичного production 1.0.0.

**Acceptance:** reviewer может для каждого шага найти источник; нет выдуманной кнопки, утверждения о выполненном device test или гарантии связи. Новичок понимает, что подготовить, какой результат записать, как отменить действие и где сообщить о сбое. Объяснено, почему app rule мешает отдельной проверке домена и почему загрузка страницы не доказывает весь путь.

**Verification:** проверить relative links/anchors и теги исходников; независимый review по guide/INSTALL/RELIABILITY/Android policy; сценарии GROW-002 дают отдельные runtime receipts. После merge проверить публичный URL и ссылку на guide. До review задача не помечается `done`, а отсутствие устройства не выдаётся за завершённую физическую проверку.

### GROW-002

**Название:** Проверить, что инструкция приводит к первому понятному результату. **Priority:** P1. **Status:** `planned`. **Owner:** onboarding QA agent. **Dependencies:** GROW-001.

**Conditional dependencies:** REL-006, REL-007.

**Dependency notes:** GROW-001; для production-сценария REL-006/007, preview можно тестировать раньше.

**Files:** `docs/guides/first-routes.md` — только исправления по наблюдению; `docs/guides/first-routes-evidence.md` — обезличенный отчёт; raw evidence в установленном evidence storage. Секреты/реальные профили не коммитить.

**Change:** выполнить Windows и Android сценарии в чистом профиле с контролируемым тестовым сервером. Для каждой платформы включить минимум четыре случая: успешный app route с Direct-контролем; domain route после снятия app-rule; недоступный профиль; отказ/cancel нужного системного разрешения и понятное восстановление. Затем OFF/повторный запуск. Записать OS/build/ABI/source/file hash, действия, наблюдаемый этап, время первого подтверждённого запроса и точку затруднения. Исполнитель не подставляет недостающую инструкцию молча; фиксирует её как дефект guide. Реальный отказ приложения не превращать в pass повторными попытками без объяснения.

**Acceptance:** все сценарии имеют observed result либо честное `not_run` с причиной; ни один undocumented workaround не остаётся скрытым. Guide исправлен и повторно проверен только на затронутом сценарии. Собственные QA-прогоны не называются внешними пользователями или конверсией. Отдельное согласие добровольного тестировщика нужно только если привлекается человек; выдуманные отзывы не создаются.

**Verification:** сопоставить новый запрос с native route evidence и, где доступно, серверным журналом; сохранить redacted screenshots без адресов/ключей. Проверить, что экспорт не включает исходную конфигурацию. Качественная цель этого этапа — воспроизводимый результат без блокирующей неоднозначности, а не заранее придуманное число пользователей.

### GROW-003

**Название:** Заполнить GitHub About и закрепить различение проекта. **Priority:** P1. **Status:** `blocked` — для изменения About нужны реальные repository administration права. **Owner:** growth agent; один UI-шаг владельца только если прав у интеграции нет. **Dependencies:** нет.

**Dependency notes:** нет; ссылка на GROW-001 добавляется после merge.

**Files:** подготовленный payload в release/growth evidence; README/Pages copy только у владельца этих файлов. Repository metadata не заменяется фиктивной правкой README.

**Change:** предлагаемый About: `Open-source VPN and proxy routing client for Windows and Android. Per-app and domain rules with your own profiles. Public preview builds.` Website: `https://innvoices.github.io/waarp/`. Темы: `vpn`, `proxy`, `split-tunneling`, `per-app-routing`, `windows`, `android`, `electron`, `kotlin`, `open-source`. Удалить неподтверждённые темы/claims при review. В кратком описании сохранять платформы и назначение, чтобы поиск отличал клиент от Waarp MFT.

**Acceptance:** About/homepage/topics действительно возвращаются repository API; название, лицензия и identity не изменены; сайт открывается, поддерживает понятную загрузку и guide. Если права отсутствуют, готовый точный payload передан владельцу, а задача остаётся blocked — не «опубликовано».

**Verification:** read-after-write repository API, публичная страница, проверка link targets. Не выполнять повторный запрос по маршруту, который уже дал авторизационный 403, без изменения прав. [GitHub topics guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

### GROW-004

**Название:** Замкнуть обратную связь в исправления первого запуска. **Priority:** P1. **Status:** `planned`. **Owner:** support/triage agent. **Dependencies:** GROW-001.

**Files:** существующие `.github/ISSUE_TEMPLATE/routing.yml`, `bug.yml`, `SUPPORT.md`; обезличенный triage log по правилам OPS. Новый публичный telemetry backend вне scope.

**Change:** использовать существующий intake; добавить только реально недостающие для воспроизведения поля после проверки дубликатов: точный downloaded filename/channel, ABI, шаг guide, expected/actual, другой VPN, observed/not_run. Сохранить предупреждение не прикладывать ключи/подписки/private endpoints и private security channel. Разбирать сообщения по установке, профилю, разрешениям, маршруту и непонятному объяснению; связывать каждый исправляемый дефект с задачей и повторной проверкой.

**Acceptance:** отчёт можно воспроизвести без секретного файла пользователя либо явно указать недостающее несекретное наблюдение; закрытый issue содержит результат проверки, а не обещание. Ответы другим людям отправляются только в рамках предоставленного разрешения на коммуникацию; автоматический triage не обещает SLA, которое никто не обеспечивает.

**Verification:** прогнать шаблон на собственном реальном success/failure receipt; убедиться, что mandatory fields не заставляют раскрывать секреты или делать опасные действия. В первых полученных отчётах считать долю воспроизводимых только с реальными numerator/denominator; пока отчётов нет — `not measured`.

### GROW-005

**Название:** Поддерживать журнал существующих заявок. **Priority:** P2. **Status:** `ready`. **Owner:** editorial/distribution agent. **Dependencies:** нет.

**Files:** компактный promotion ledger в согласованном evidence storage, содержащий channel/source/submitted_at/receipt/status/checked_at/next_allowed_action. Старый аудит из 67 строк не выдаётся за 67 разных аудиторий.

**Change:** один раз после появления нового выпуска Android/Kotlin Weekly проверить фактическое включение; прочитать ответ в lgg issue12 и опубликованную карточку OpenSourceDex. Записывать отдельно submitted, awaiting_review, published, declined, blocked_access и failed_validation. К статусу published нужен прямой URL с реальным присутствием Waarp. Follow-up только на конкретный вопрос или при предусмотренном редакцией процессе; старый выпуск, тишина и отсутствие в поиске не равны отказу.

**Acceptance:** нет повторной nomination, пустого bump, повторного 403/502 или повторной It’s FOSS формы без требуемого поля. Подтверждённые публикации имеют URL/дату и точный текст/краткую выжимку; обещанный или заявленный охват редакции не приписан проекту. Оповещение об изменённых страницах IndexNow отправляется только после реального deploy и не считается индексацией.

**Verification:** прямой read первичного issue/страницы/выпуска; сравнить с исходным receipt. При доступном только search excerpt явно записать предел проверки. Сохранять дату, а не строить бесконечный polling в текущем сеансе.

### GROW-006

**Название:** Провести один адресный запуск после готовности поставки. **Priority:** P2. **Status:** `blocked` — production-материал ожидает REL-008; отдельный preview-материал допустим только с явным preview-текстом и проходимым intake. **Owner:** growth agent + maintainer для личных площадок. **Dependencies:** GROW-001, GROW-002, GROW-004, GROW-007, DIST-001.

**Conditional dependencies:** REL-008.

**Dependency notes:** GROW-001/002/004/007, DIST-001; production — REL-008.

**Files:** platform-specific brief с canonical URL, exact release, audience, demonstrated scenario, limitations, feedback link, verified rules и receipt. Внешние draft/post outputs не перемешивать с исходниками приложения.

**Change:** выбрать одну площадку, где разрешены формат, автоматизация и self-promotion, есть нужный доступ и отсутствует текущая заявка. Написать материал вокруг выполненного сценария первого маршрута и его фактической приёмки. Явно указать связь автора с проектом, поддерживаемую платформу и ограничения. В качестве следующего технического материала использовать собственное доказанное решение реальной проблемы, например различие app/domain routing и общей DNS на Android; не переносить диагностическую гипотезу в claim об исправлении. Для HN/других личных форматов владелец пишет свой текст, агент даёт factual packet в рамках правил площадки.

**Acceptance:** до отправки сохранены правила и один готовый reviewable материал; после — действительный receipt/URL либо точная ошибка. Нет mass posting, чужих рекомендаций от имени пользователя, искусственных stars или engagement. Если доступного канала нет, результат этапа — опубликованный полезный guide и следующая воспроизводимая задача по feedback, а не очередной список непроходимых сайтов.

**Verification:** check eligibility/duplicate/source immediately before action; одна разрешённая отправка; прочитать фактический результат. Затем разбирать ответы через GROW-004. Не называть публикацию успешной установкой или обещать внешнюю модерацию.

### GROW-007

**Название:** Измерять наблюдаемые результаты без выдуманной атрибуции. **Priority:** P1. **Status:** `ready`. **Owner:** measurement agent. **Dependencies:** нет.

**Dependency notes:** нет; baseline снять до GROW-006.

**Files:** датированные JSON/таблица в согласованном evidence storage; при автоматизации только read-only collectors с явно доступными scopes. Не добавлять tracking SDK в VPN-клиент ради продвижения.

**Change:** снять baseline и сопоставимый последующий срез: repo stars/forks, каждый public asset `download_count`, реальные опубликованные упоминания, входящие воспроизводимые reports. При наличии push access сохранить GitHub Traffic views/clones/referrers/popular paths, указав UTC window и источник. GitHub хранит эти traffic показатели за последние 14 дней, поэтому запланированная отдельно повторяемая выгрузка должна укладываться в это окно; отсутствие доступа означает unavailable, не ноль. Campaign-tagged links полезны только если принимающая система реально учитывает метки; сами UTM-параметры не создают аналитики.

**Acceptance:** каждое число имеет дату, единицу, определение, источник и ограничения. Asset downloads не называются installs/unique users и могут включать собственные/CI запросы; разница после поста не считается причинно доказанным эффектом. Счётчики разных окон и платформ не складываются в «охват». Conversion вычисляется только при наблюдаемом связанном знаменателе и числителе; иначе приводятся отдельные величины. Содержимое запросов, endpoints и профили пользователей не собираются.

**Verification:** сверить исходный API response/Traffic export и вычисленную дельту; помечать внутренние QA downloads, где они известны, не пытаться угадывать остальные. Источники: [GitHub Traffic](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository), [Traffic REST API](https://docs.github.com/en/rest/metrics/traffic), [release assets API](https://docs.github.com/en/rest/releases/assets). Первый review после адресной публикации отвечает на три вопроса: пришёл ли наблюдаемый интерес, смогли ли реальные тестировщики выполнить guide, какие подтверждённые сбои нужно исправить прежде следующей публикации.

## Передача между агентами и завершение

Distribution/growth agent владеет подготовкой manifests, точных описаний, guide и журналом внешних результатов. Release agent передаёт accepted asset identities и gate receipts; BLD — component/size/provenance; UX — реальные captures и observed onboarding; OPS — сохранность и ссылки на evidence. Никто не создаёт новый signing key, не ослабляет CI, не «исправляет» результаты приёмки и не переименовывает debug build в production ради следующего канала.

Для закрытия задачи нужны изменённые файлы, reviewer, фактически выполненная verification, ссылка на evidence и оставшиеся ограничения. Статус blocked содержит конкретное действие, которое его снимает. Отсутствие ответа каталога не мешает выпускать полезные собственные документы, поддерживать официальные загрузки и исправлять наблюдаемые проблемы пользователей.
