# Evidence для исходного кода 2305781

Исходный commit: [`230578139014639be497d10c30bd9da4d631cb28`](https://github.com/INNVoices/waarp/commit/230578139014639be497d10c30bd9da4d631cb28). Итоговая интерпретация и открытые границы — в [09-ACCEPTANCE.md](../../09-ACCEPTANCE.md). Наличие отчёта о собранном пакете не означает доступность бинарного файла для скачивания.

## Windows

[Run 44300906714](https://github.com/INNVoices/waarp/actions/runs/44300906714) содержит две попытки одного кода с неизменными gates.

| Evidence | Содержание |
| --- | --- |
| [Первая попытка: derived JSON](windows-attempt1-lifecycle-derived.json) и [исходные выбранные строки](windows-attempt1-lifecycle.txt) | 15/50 и PowerShell snapshot timeout. Исходного lifecycle JSON в сохранённом log нет; cleanup не выводится из generic runner cleanup |
| [Первый UI gate](windows-ui.txt) и [manifest](windows-ui.json) | UI прошёл до отдельного lifecycle failure; сохранённая [галерея](../../../../screenshots/atlas-2026-11-18/README.md) использует именно эти кадры |
| [Происхождение второго прогона](windows-attempt2-provenance.json) | Commit, job, соответствие имён, различие исходных отчётов и производных сводок, размеры и SHA-256 |
| [50 lifecycle cycles](windows-attempt2-native-lifecycle-50.log) | 50/50, 428056 ms при прежнем budget 600000 ms |
| [Selector TCP/UDP experiment](windows-attempt2-continuity-native.json) | Реальное закреплённое ядро, локальные SOCKS endpoints; область experiment ограничена loopback |
| [Native acceptance](windows-attempt2-native-acceptance.log) | Сохранённые native PASS строки, включая route/lifecycle |
| [Package integrity](windows-attempt2-package-integrity.json) | Точный SHA кода, EXE checksum, размер, runtime и pinned engine |
| [Второй UI gate](windows-attempt2-ui-acceptance.log) и [visual review](windows-attempt2-visual-review.json) | Повторный renderer/UI PASS; используемые данные синтетические |
| [Состояния шагов](windows-attempt2-job-status.json) | Product steps PASS; uploads quota FAILURE; переносимый EXE upload SKIPPED |

JSON native/package извлечены из полей, напечатанных настоящими checks, и отформатированы для чтения. Выбранные log-строки сохранены дословно. Производные manifests/visual notes не выдаются за исходный native report; mapping указан в provenance.

## Android

[Run 44300906671](https://github.com/INNVoices/waarp/actions/runs/44300906671), job `134790064761`: Android 15/API35/x86_64 emulator, страницы 4096 bytes. Пять JSON скопированы из напечатанных отчётов байт в байт.

| Evidence | Содержание |
| --- | --- |
| [JVM tests](android-unit-tests.json) | 204/204, без ошибок и пропусков |
| [Native route/feedback](android-route-smoke.json) | 5/5, восемь подтверждённых mutations в одной TUN/native session |
| [Gallery](android-gallery.json) | 4/4, шесть обязательных кадров и дополнительные readiness captures; native crash evidence |
| [APK reports](android-artifacts.json) | Собранные APK, размеры и checksums; это отчёт сборки, не ссылка на опубликованный APK |
| [Core provenance](android-core-build-report.json) | Закреплённый Android native source/build |
| [UI provenance и hashes](../../../../screenshots/atlas-2026-11-18/android-provenance.json) | Реальные normal/150% PNG, среда, статусы product/delivery шагов и точные хеши этих пяти отчётов |

Upload quota делает общий job красным. Полные зависимые API matrix, optimized release acceptance и двухчасовой soak получили SKIPPED. Статический APK gate совместимости с 16 KB не заменяет runtime test на устройстве с 16 KB страницами.
