# История кандидата r4 — 8482dfc

Источник: [`8482dfcce4d554ee7448ea9d5c8810c6c3e38694`](https://github.com/INNVoices/waarp/commit/8482dfcce4d554ee7448ea9d5c8810c6c3e38694). Этот кандидат **не опубликован**: Android UI gallery остановилась на неоднозначном тестовом выборе текста France. Поле поиска и строка страны имели совпавший текст. Windows завершил свой preview job и загрузил четыре файла в draft; они не являются итоговым выпуском r5.

| Файл | Источник и смысл |
| --- | --- |
| [windows-stability.json](windows-stability.json) | Preview Windows job 134828161088, run 44311748318: emitted metrics100cycles PASS |
| [windows-package.json](windows-package.json) | Тот же preview job: actual EXE metadata/hash; пакет кандидатаr4, не будущийr5 |
| [windows-native-summary.txt](windows-native-summary.txt) | Неизменённые выбранные строки preview log: routing PASS и50/50 TUN |
| [windows-selector-continuity.json](windows-selector-continuity.json) | General Windows job 134827370769/run 44311748184 на том же SHA: loopback soft/strict experiment; не WAN/game latency |
| [android-jvm.json](android-jvm.json) | Preview Android job 134828160949/run 44311748318:204/204 JVM PASS |
| [android-native.json](android-native.json) | Тот же Android job:5/5 native/feedback PASS |
| [android-gallery-failed.json](android-gallery-failed.json) | Тот же Android job:3/4gallery PASS, один конкретный failure |
| [android-selector-failure.txt](android-selector-failure.txt) | Точный фрагмент ошибки: EditableText France и Text France; строка343 существующего сценария |

JSON сохраняют выведенные отчётами поля; форматирование для чтения не считается оригинальным CI archive. Текстовые фрагменты содержат реальные выбранные строки. Общее состояние Android job — FAILURE; эти отдельные успешные gates не подменяют его. Последующий минимальный фикс выбирает строку без SetText action и сохраняет прежние утверждения сценария. Актуальная приёмка находится в [09-ACCEPTANCE.md](../../09-ACCEPTANCE.md).
