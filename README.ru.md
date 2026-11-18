<p align="center"><img src="docs/brand/waarp-cover.svg" width="100%" alt="Waarp · маршрутизация приложений для Windows и Android"></p>

<p align="center"><strong>Windows 10/11 x64 · Android 10+ · 1.0.0</strong><br>
<a href="README.md">English</a> · Русский · <a href="https://github.com/INNVoices/waarp/releases">Скачать</a> · <a href="docs/README.md">Документация</a></p>

# Свой маршрут для каждого приложения

Можно направить браузер через личный VPN, выбрать отдельное подключение для сайта и оставить остальной трафик на прямом соединении. Оба клиента поддерживают сохранённые профили, группы и каталог публичных узлов. Режим «Авто» выбирает подходящее подключение из библиотеки.

| Windows | Android |
| --- | --- |
| Маршруты для процессов, сервисов и доменов. Просмотр активного пути, счётчиков трафика и результатов диагностики. | Правила для приложений и доменов, импорт профилей и переключение маршрутов в нативном клиенте на Kotlin. |
| [Выбор сервера](docs/SERVER-SELECTION-2026-11-18.md) · [Карта и диагностика](docs/CONNECTION-TOOLS.md) | [Устройство клиента](docs/ANDROID.md) · [Сборка и подпись](docs/ANDROID.md#build-and-install) |

[![Каталог серверов Windows](docs/screenshots/preview-r6/desktop-public-real-1240.png)](docs/screenshots/preview-r6/README.md)

## Сборка на ПК

| Команда | Результат |
| --- | --- |
| `build.bat 1` | Распакованное приложение в `dist/win-unpacked/` |
| `build.bat 2` | Portable EXE с номером версии в `dist/` |
| `build.bat apk` | Проверенные debug APK для ARM64, ARM32 и x86_64 в `out/android/` |

Нужен Node.js 22. Для Android также нужны JDK 17 и Python 3. Нативное ядро уже входит в исходное дерево. Первая сборка загружает платформу SDK и Build Tools (около 125 МБ), а также Gradle и библиотеки Maven. Следующие сборки используют локальный кеш. [Компоненты и результаты приёмки](docs/V1.md).

## Установка и проверка

Выберите файл для своей платформы в [GitHub Releases](https://github.com/INNVoices/waarp/releases) и сверьте SHA-256 с контрольной суммой выпуска. У debug APK отдельный идентификатор `local.waarp.android.debug`. Для обновления production-приложения нужен исходный сертификат подписи. Опубликованные ранее preview сохранили свои номера версий. [История выпусков](docs/RELEASES.md).

В Windows запуск туннеля требует повышения прав. При старте клиент проверяет ядро, для хранения секретов использует DPAPI. В Android используются системное разрешение VPN и Android Keystore. Публичными узлами управляют сторонние операторы. После остановки ядра Windows может вернуть трафик на обычный маршрут. [Поведение при сбоях](docs/RELIABILITY.md) · [Источники узлов](docs/SOURCES.md) · [Сообщить об уязвимости](SECURITY.md).

## Проект

[Участие](CONTRIBUTING.md) · [Поддержка](SUPPORT.md) · [Планы](ROADMAP.md) · [Галерея](docs/screenshots/README.md) · [Авторы и зависимости](THIRD_PARTY_NOTICES.md)

Код приложения Windows распространяется по [Apache-2.0](LICENSE), код приложения Android — по [GPL-3.0-or-later](android/LICENSE). В состав клиентов включены уведомления о лицензиях ядра и библиотек.
