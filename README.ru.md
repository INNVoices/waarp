<p align="center"><img src="docs/brand/waarp-cover.svg" width="100%" alt="Waarp · маршрутизация приложений для Windows и Android"></p>

<p align="center"><strong>Windows 10/11 x64 · Android 10+ · Публичные preview-сборки</strong><br>
<a href="README.md">English</a> · Русский · <a href="https://innvoices.github.io/waarp/">Страница проекта</a> · <a href="docs/INSTALL.md">Установка</a> · <a href="docs/README.md">Документация</a></p>

# Свой маршрут для каждого приложения

Waarp — открытый клиент для маршрутизации через VPN и прокси на Windows и Android. Можно направить браузер через личное подключение, выбрать другое для сайта и оставить остальной трафик на прямом соединении.

## Скачать и установить

| Платформа | Скачать | Проверить |
| --- | --- | --- |
| Windows 10/11 x64 | **[Portable EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/Waarp-0.4.1-rc.5-portable.exe)** · 0.4.1-rc.5, без цифровой подписи | [Контрольные суммы SHA-256](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/SHA256SUMS-windows.txt) · [Выпуск r6](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r6) |
| Android 10+ · ARM64 | **[APK для Android](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-arm64-v8a-debug.apk)** · 0.5.0-rc.5, debug-подпись | [Контрольные суммы SHA-256](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/SHA256SUMS-android-debug.txt) · [Выпуск r5](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r5) |

Другие архитектуры Android: **[ARM32](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-armeabi-v7a-debug.apk)** · **[x86_64](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-x86_64-debug.apk)**. Для большинства современных телефонов подходит ARM64.

Для загрузок через Obtainium есть [инструкция по импорту и обновлениям](docs/INSTALL.md#obtainium).

Это публичные **preview-сборки**. Исходники в `main` имеют версию **1.0.0**, но готовый публичный выпуск 1.0.0 ещё не опубликован. Файлы выше сохранили свои исходные версии и не содержат все последующие изменения кода. [Статус выпусков и результаты проверок](docs/RELEASES.md).

Откройте **[инструкцию по установке и первому маршруту](docs/INSTALL.md)** и сверьте скачанный файл с контрольной суммой того же выпуска. В Windows запуск туннеля требует повышения прав. Android запрашивает системное разрешение VPN; debug APK устанавливаются отдельно как `local.waarp.android.debug` и не обновляют production-приложение. Для production-обновлений нужен исходный сертификат подписи.

Для первого опыта есть [пошаговое руководство: приложение → личный профиль → проверка Direct → отдельный домен](docs/guides/first-routes.md). Оно соответствует доступным preview Windows r6 и Android r5.

## Возможности маршрутизации

Оба клиента поддерживают сохранённые профили, группы и необязательный каталог сторонних публичных узлов. Режим «Авто» выбирает подходящее подключение из библиотеки.

| Windows | Android |
| --- | --- |
| Маршруты для процессов, сервисов и доменов. Просмотр активного пути, счётчиков трафика и результатов диагностики. | Правила для приложений и доменов, импорт профилей и переключение маршрутов в нативном клиенте на Kotlin. |
| [Выбор сервера](docs/SERVER-SELECTION-2026-11-18.md) · [Карта и диагностика](docs/CONNECTION-TOOLS.md) | [Устройство клиента](docs/ANDROID.md) · [Сборка и подпись](docs/ANDROID.md#build-and-install) |

[![Каталог серверов Windows в опубликованном preview r6](docs/screenshots/preview-r6/desktop-public-real-1240.png)](docs/screenshots/preview-r6/README.md)

Публичными узлами управляют сторонние операторы; доступность зависит от узла и вашей сети. При старте клиент Windows проверяет ядро, для хранения секретов использует DPAPI. В Android используется Android Keystore. Отдельного firewall kill switch в Windows нет: после остановки ядра система может вернуть трафик на обычный маршрут. [Поведение при сбоях](docs/RELIABILITY.md) · [Источники узлов](docs/SOURCES.md) · [Сообщить об уязвимости](SECURITY.md).

## Сборка исходников 1.0.0 на ПК с Windows

| Команда | Результат |
| --- | --- |
| `build.bat 1` | Распакованное приложение в `dist/win-unpacked/` |
| `build.bat 2` | Portable EXE с номером версии в `dist/` |
| `build.bat apk` | Проверенные debug APK для ARM64, ARM32 и x86_64 в `out/android/` |

Нужен Node.js 22. Для Android также нужны JDK 17 и Python 3. Его нативное ядро уже входит в исходное дерево. Первая сборка загружает платформу SDK и Build Tools (около 125 МБ), а также Gradle и библиотеки Maven. Следующие сборки используют локальный кеш. [Компоненты и результаты приёмки кода](docs/V1.md) описывают исходники 1.0.0 и границы их проверки; это отдельная запись от приёмки опубликованных preview.

## Языки интерфейса в исходниках 1.0.0

Windows и Android выбирают первый поддерживаемый язык из системного списка. На Android 13 и новее язык Waarp можно выбрать отдельно в системных настройках приложения. Текущие исходники включают русский, английский, немецкий, французский, испанский, бразильский португальский, китайский (упрощённый и традиционный), японский, корейский, украинский, итальянский, польский, турецкий, арабский, хинди, индонезийский, вьетнамский и персидский. Язык по умолчанию — русский. Этот список относится к `main`, а не к более ранним preview-сборкам по ссылкам выше.

## Проект

[Участие](CONTRIBUTING.md) · [Поддержка](SUPPORT.md) · [Планы](ROADMAP.md) · [Галерея](docs/screenshots/README.md) · [Все выпуски](https://github.com/INNVoices/waarp/releases) · [Авторы и зависимости](THIRD_PARTY_NOTICES.md)

Код приложения Windows распространяется по [Apache-2.0](LICENSE), код приложения Android — по [GPL-3.0-or-later](android/LICENSE). В состав клиентов включены уведомления о лицензиях ядра и библиотек.
