# Фактические результаты preview r5

Исходный код: [`928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`](https://github.com/INNVoices/waarp/commit/928c9a8e3cd0a83a41ebfa15c2628ddb610ea157). [Preview run 44316534164](https://github.com/INNVoices/waarp/actions/runs/44316534164) завершился SUCCESS во всех пяти jobs и опубликовал r5. Этот каталог содержит выведенные программами JSON, ограниченные точные строки журналов и отдельно отмеченные сведения API; это не полный исходный CI archive.

| Материал | Происхождение и граница |
| --- | --- |
| [windows-stability.json](windows-stability.json) | Windows preview job 134844904516: 100 renderer cycles, изолированный IPC; native сеть этим сценарием не измеряется |
| [windows-native-summary.txt](windows-native-summary.txt) | Точные выбранные строки того же job: selector, TCP/UDP/DNS, PID/TUN/соседний поток,50/50 lifecycle |
| [windows-package.json](windows-package.json) | Фактическая версия, source commit, размер и SHA-256 EXE; совпали с опубликованным asset |
| [android-jvm.json](android-jvm.json) | Android preview job 134844904814: 204/204 JVM |
| [android-native.json](android-native.json) | Тот же Android job:5/5 native/feedback и восемь ACK в одной session; не внешняя доступность сервера |
| [android-gallery.json](android-gallery.json) |4/4 реальных UI-сценария на API 35; без skips/failures |
| [android-build-artifacts.json](android-build-artifacts.json) | Выведенные сведения шести debug/release-unsigned APK; опубликованы только три debug ABI |
| [release-verification.json](release-verification.json) | API release/tag/run/jobs после публикации:9 assets с digests, exact source и ручная визуальная проверка финальных кадров |
| [general-windows-status.json](general-windows-status.json) | Отдельный general run 44316534397/job 134844018930: UI budget FAIL; selector PASS; дальнейшие route/TUN/package skipped |
| [general-windows-failure.txt](general-windows-failure.txt) | Точные выбранные строки этого failure и позднейших quota-ошибок; причина превышения 90 s неизвестна |

[Неизменённые кадры и их hashes](../../../../screenshots/preview-r5/README.md) · [Приёмка и ограничения](../../09-ACCEPTANCE.md). Отдельный общий CI не объявляется зелёным из-за успешного preview. История предыдущего неопубликованного кандидата находится в [8482dfc](../8482dfc/README.md).
