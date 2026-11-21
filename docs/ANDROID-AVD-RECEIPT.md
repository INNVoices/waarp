# Host AVD receipt: REL-009

`scripts/android-avd-receipt.py` сохраняет недостающую host metadata для расследования
`GoldfishMapper::readFromHost` / `hasReadColorBufferDma`. Это ограниченное read-only
наблюдение на явно принадлежащем CI одноразовом Linux runner. Collector не запускает
SDK tools, subprocesses или ADB; не меняет image, AVD, GPU, tracing, package manager,
параметры приложения или бюджеты существующей приёмки.

## Запуск

Выполнить **внутри `script:` emulator action после запуска эмулятора и до первого
app install / release preparation**, пока процесс и `hardware-qemu.ini` ещё доступны:

```sh
python3 scripts/android-avd-receipt.py \
  --sdk-root "$ANDROID_HOME" \
  --avd-home "${ANDROID_AVD_HOME:-$HOME/.android/avd}" \
  --avd-name test \
  --port 5554 \
  --disposable-ci-host \
  --report out/android/device-tests/host-avd-live.json
```

Для release journeys каталог отчёта — `out/android/release-journeys`;
для soak — `out/android/release-soak`. Существующий upload runtime directory
сохранит JSON. Live observation нужно получить до teardown; не переиспользовать
имя уже существующего отчёта. CLI требует явные SDK/AVD roots и ownership flag.

Отдельный `always()` step после action, в том числе при boot failure, может сохранить
оставшиеся host files в **другое** имя с явным `--metadata-only`:

```sh
python3 scripts/android-avd-receipt.py \
  --sdk-root "$ANDROID_HOME" \
  --avd-home "${ANDROID_AVD_HOME:-$HOME/.android/avd}" \
  --avd-name test --port 5554 --disposable-ci-host --metadata-only \
  --report out/android/device-tests/host-avd-after.json
```

В этом режиме `processCollectionRequested=false`, `/proc` не читается и live argv
не утверждается. Отсутствующие после неудачного boot файлы дадут неполный receipt;
диагностический step не должен перезаписывать live report или скрывать исходный
boot/install failure. Ни один режим не перезапускает эмулятор для сбора evidence.

Exit `0` означает только `collectionComplete=true`; exit `1` означает отказ или
неполный сбор. Даже при ошибке чтения создаётся неполный receipt, если валидны
начальные paths/ownership и output доступен. Предыдущий receipt не перезаписывается.
Сбор не заменяет install, PAGE_SIZE, UI, crash, trace или traffic gates. Его результат
не разрешает повторный запуск упавшей проверки и не превращает её в success.

## Что сохраняется

- Root `<AVD_HOME>/test.ini`: `target` и булево соответствие `path` ожидаемому
  `<AVD_HOME>/test.avd`. Произвольный `path` из файла никогда не используется для
  чтения другого каталога.
- `config.ini` / `hardware-qemu.ini`: только image identity, ABI, CPU/RAM/heap,
  размер data partition и графические параметры из явного allowlist.
- SDK `emulator/source.properties`, `cmdline-tools/latest/source.properties` и
  `source.properties` выбранного image: версии и ограниченные identity fields.
  Если `latest` — symlink внутри SDK, receipt показывает разрешённый относительный
  путь. Отдельный выход symlink из SDK отвергается.
- Необязательные emulator/image `advancedFeatures*.ini`: только `GLDirectMem`,
  `HasSharedSlotsHostMemoryAllocator`, `GLDMA`, `GLDMA2`, `GLAsyncSwap`.
- Из `/proc` — только процесс текущего UID с ожидаемым SDK emulator executable,
  точным AVD name и port. Сохраняются PID, SDK-relative executable и разрешённые
  emulator options; HTTP proxy, gRPC credentials, environment и неизвестные argv
  values не сохраняются. Полный cmdline не копируется.

У каждого прочитанного файла сохраняются размер и SHA-256 исходных байтов;
неизвестные property values не экспортируются. У подходящего процесса сохраняются
размер и SHA-256 исходного cmdline, но только allowlisted argv. Хеш не является
криптографическим доказательством авторства CI и не позволяет восстановить
отброшенную часть файла. JSON следует хранить внутри обычного artifact с receipt
выбранного run/attempt.

Action добавляет некоторые config keys повторно. Collector сохраняет их значения
в `repeatedPropertyValuesInFileOrder`; `properties` содержит последнее увиденное
значение, **без утверждения о правилах precedence конкретного emulator binary**.
Повторные identity keys `path`, `target`, `image.sysdir.1` считаются неоднозначными
и не используются как успешная идентификация.

## Ограничения и интерпретация

Максимум на input file / cmdline — строго меньше **64 KiB**, максимум **2 048**
просмотренных `/proc` entries и **8** процессов из SDK; общий host collection
deadline — **5 секунд**. Он ограничивает только новый collector; существующие
guest preparation / install / ftrace / acceptance budgets не меняются. Читаются
только фиксированные файлы; recursive directory scans, FIFOs/device reads,
arbitrary paths и повторные попытки не используются.

`targetMajorMatchesImage=false` — наблюдаемое расхождение root AVD target и
установленного image. Это полезный сигнал, но не утверждение о фактическом
`avdInfo_getApiLevel()` внутри непроверенного binary. Поэтому
`effectiveEmulatorApiLevel=null`, `hostFeatureNegotiationVerified=false` и
`runtimeAcceptance=not-assessed` остаются явными. Настройки `advancedFeatures.ini`
не доказывают effective feature state или ответ host extensions. `source.properties`
не удостоверяет хеш исполняемого SDK binary или фактически вызванный ранее
`avdmanager`; invocation/version provenance нужно сопоставлять с CI log.

## Основание следующего causal experiment

В main run [44857532546](https://github.com/INNVoices/waarp/actions/runs/44857532546)
native API36 снова завершился отсутствием `package` после ранних SurfaceFlinger
aborts. Artifact `14688706051`, SHA-256
`d0814529b939722e634142721a287e7c0720d0b8ea0fb9bedc67fbc0052da4b7`,
имеет проверенные ZIP size/CRC/digest; host AVD target и cmdline-tools version в нём
не сохранены. Этот collector закрывает именно пробел наблюдения, а не сам crash.

В [pinned action `sdk-installer.ts`](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/sdk-installer.ts)
bundled cmdline-tools устанавливаются только при отсутствии каталога
`$ANDROID_HOME/cmdline-tools`; иначе используются уже установленные `latest/bin`.
[`createAvd()`](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/emulator-manager.ts)
передаёт `system-image-api-level` в package identifier, но сам не записывает root
AVD target. Input `api-level: 36` не является наблюдением host-parsed AVD API.

Reference source связывает
[AVD target parser](https://github.com/aosp-mirror/platform_external_qemu/blob/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/emu/avd/src/android/avd/info.c#L461-L539),
[allocator disable для API < 30](https://github.com/aosp-mirror/platform_external_qemu/blob/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android-qemu2-glue/main.cpp#L2730-L2736),
[host extension predicate](https://github.com/google/gfxstream/blob/0eb17af5d0216fce174aa63abe6098367931a20f/host/render_control.cpp#L449-L476)
и [guest capability query](https://github.com/google/gfxstream/blob/0eb17af5d0216fce174aa63abe6098367931a20f/guest/renderControl_enc/ExtendedRenderControl.cpp#L274-L280).
Эти commits пока не сопоставлены с конкретным emulator build 16970787. Поэтому
сначала нужен фактический receipt; изменение SDK/AVD generation оправдывается
подтверждённым mismatch и отдельным before/after при неизменных image/backend и
приёмочных guards. Ftrace/BPF blocker REL-003 расследуется независимо.

## Host regression checks

```sh
python3 scripts/android-avd-receipt-test.py
python3 -m py_compile scripts/android-avd-receipt.py scripts/android-avd-receipt-test.py
```

Fixtures проверяют unsafe paths/symlinks/FIFO, ограничения размера и process scan,
wrong AVD/port/executable, explicit ownership, сохранение старого receipt, unknown
secret values, реальные repeated config keys action и несовпадающий target без
ложного runtime pass. Они не запускают эмулятор и не заменяют actual receipt.
