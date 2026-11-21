# REL-009: исправлен AVD target, native runtime подтверждён

## Установленный дефект конфигурации

В [PR42 Android run 44862192000](https://github.com/INNVoices/waarp/actions/runs/44862192000)
на head `7c21bb0a000987682ef57ff21e324857491bb61f` оба API36 задания записали
`test.ini: target=android-0`, хотя image имеет `AndroidVersion.ApiLevel=36.1`,
revision `4`, ABI `x86_64`, base SDK `true`, extension `20`.
`cmdline-tools/latest/source.properties` показывает `Pkg.Revision=12.0`.
Это проверенные host metadata, а не версия, угаданная по образу GitHub runner.

| Доказательство | Native API36 | Release API36 |
| --- | --- | --- |
| Job | [136719836426](https://github.com/INNVoices/waarp/actions/runs/44862192000/job/136719836426) | [136719836586](https://github.com/INNVoices/waarp/actions/runs/44862192000/job/136719836586) |
| Artifact ID | `14691090380` | `14690652483` |
| ZIP bytes | `45694` | `27221` |
| ZIP SHA256 | `5b3fd84e83fdbabc3955c7edb0c6b44efb525ac0ebe40731f2ee59e7de85896f` | `df8bd658a38d0ba15cdff6d498658b94b6af9a705d5048d68bf1a7f09ac8c009` |

Для обоих ZIP проверены GitHub artifact receipt с run/head, длина, SHA256, CRC и
имена entries. `host-avd-live.json` неполон только в части `/proc` attribution:
selected file metadata доступны, но owned emulator argv не получен.
`host-avd-after.json` metadata-only имеет `collectionComplete=true`; каждый input
file hash совпадает с live observation и со вторым job. Это не доказывает effective
host API или результат feature negotiation.

[Исходный host receipt](production/evidence/2026-11-21-pr42-api36-host.json) —
точная копия `host-avd-after.json` из native artifact `14691090380`: 5973 bytes,
SHA256 `6e6affd28d69df7b4b5cbd0002005162c8495e211fa64e100c777836a01b3ca1`.
Emulator metadata: `37.3.10`, build `16970787`; generated hardware GPU `lavapipe`,
RAM `4096`, data partition `4g`. Image/package, GPU и ресурсы сохраняются.

## Причинная гипотеза и выбранное изменение

[Pinned action installer](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/sdk-installer.ts)
объявляет tools 20.0, но при существующем `cmdline-tools/` использует `latest/bin`
без проверки версии. В нашем receipt там 12.0.
[Upstream runner-images issue](https://github.com/actions/runner-images/issues/14484)
содержит отдельные измерения неправильного Major.Minor target на 12.0 и правильного
на 20.0/22.0. Это поддерживает выбор версии; чужой A/B test не заменяет наш runtime.

Reference emulator [target parser](https://github.com/aosp-mirror/platform_external_qemu/blob/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/emu/avd/src/android/avd/info.c#L461-L539)
превращает `android-0` в низкий API. [API<30 branch](https://github.com/aosp-mirror/platform_external_qemu/blob/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android-qemu2-glue/main.cpp#L2730-L2736)
отключает shared-slots allocator; [GLDirectMem auto-enable](https://github.com/aosp-mirror/platform_external_qemu/blob/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/android-ui/modules/aemu-ui-window/src/android/main-common-ui.c#L316-L377)
также учитывает API. В gfxstream [оба флага требуются](https://github.com/google/gfxstream/blob/0eb17af5d0216fce174aa63abe6098367931a20f/host/render_control.cpp#L449-L476)
для `ANDROID_EMU_read_color_buffer_dma`, по которому guest выставляет
`hasReadColorBufferDma`. Это объясняет проверяемую гипотезу graphics assertion;
source commits не являются аттестацией точного бинарного emulator build.

Установить точный SDK package **`cmdline-tools;20.0`** и создать **новый** AVD `test`
явным `<SDK>/cmdline-tools/20.0/bin/avdmanager` с прежними package
`system-images;android-36.1;google_apis_ps16k;x86_64` и profile `pixel_6`.
Версионированные packages поддерживает [официальный sdkmanager](https://developer.android.com/tools/sdkmanager).
`latest` не переписывается, target вручную не редактируется, existing AVD не заменяется.

`scripts/android-avd-create-pinned.py` требует original receipt, точные hashes
исходного latest/image `source.properties`, установленный `Pkg.Revision=20.0`,
отсутствие `test.ini`/`test.avd` и явное disposable-host ownership. Одна команда с
timeout 120 s должна создать только `android-36` / `android-36.1` и точный image
directory. Другие major/minor/unknown formats отказываются; результат сохраняется.
Boot, retry и recovery отсутствуют. Existing job, guest, PAGE_SIZE, UI и ftrace
budgets/gates не меняются.

## Workflow wiring для coordinator

До emulator action, только API36, включая отдельный soak:

```sh
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install 'cmdline-tools;20.0'
"$ANDROID_HOME/cmdline-tools/20.0/bin/sdkmanager" --install 'system-images;android-36.1;google_apis_ps16k;x86_64' --channel=0
python3 scripts/android-avd-create-pinned.py \
  --sdk-root "$ANDROID_HOME" --avd-home "$HOME/.android/avd" \
  --observed-host-receipt docs/production/evidence/2026-11-21-pr42-api36-host.json \
  --disposable-ci-host --report out/android/device-tests/avd-create.json
```

Report directory выбирается по job: `device-tests`, `release-journeys` или
`release-soak`. Creation failure останавливает boot. У action
`force-avd-creation: ${{ matrix.api != 36 }}` в matrix и `false` в API36 soak:
старый latest не создаёт AVD повторно, штатный config append сохраняет RAM/heap/disk.
Pinned action экспортирует `ANDROID_AVD_HOME=$HOME/.android/avd`; creator использует тот же root, чтобы action переиспользовал созданный AVD. Coordinator владеет workflow. SDK install — официальный package install; новый шаг
не изменяет upstream action/provenance patch.

До action используется именно `$HOME/.android/avd`: pinned installer безусловно
экспортирует этот `ANDROID_AVD_HOME`. Поэтому caller не должен создавать AVD в
другом inherited root. После action live/after collectors могут использовать
его экспортированное значение, как и раньше.

Raw `avd-create.stdout`/`avd-create.stderr`, creation report и прежние live/after
receipts остаются в runtime artifact. Host receipt по-прежнему описывает исходный
`latest=12.0`; фактический инструмент создания `20.0` фиксирует creation report.
Не приписывать creation старому latest. Если image revision, исходные tools или
emulator build изменились, причинное сравнение нужно оценить заново.

## Проверка и пределы

```sh
python3 scripts/android-avd-create-pinned-test.py
```

Tests используют mock runner и temporary SDK fixtures: correct/неполный original
receipt, already-new tools, changed source hashes, existing AVD, wrong selected
version, точный единичный SDK20 call, unchanged latest и сохранение неверного target
без retry. Отдельный negative fixture отвергает 35/37/999, 36.2 и unknown target.
Реальный reviewed receipt отдельно проходит parser этого helper.
**SDK20 avdmanager и исправленный runtime локально не запускались.**

Creation report связывает original receipt SHA256, selected source.properties,
wrapper hash, точные arguments и созданные INI/config hashes. Это inventory и
связность доверенного CI input, не самостоятельная аттестация SDK JAR payload или
авторства произвольного JSON. Успех helper означает только корректное создание AVD.
Фактическое наблюдение после исправления приведено ниже. Полный release acceptance по-прежнему требует всю matrix и soak.

## Фактический результат PR44

В [run44864148533](https://github.com/INNVoices/waarp/actions/runs/44864148533) оба API36 creator шага успешно создали `target=android-36.1` через tools20.0 без ручного изменения target. Image36.1 r4 и GPU flags сохранены. Native API36 прошёл **26/26 tests, 0 failed, 0 skipped** за265.1s; прежний отказ до установки больше не остановил этот сценарий.

[Проверенная запись](production/evidence/2026-11-21-api36-sdk20-accepted.json) содержит immutable artifact IDs, raw API receipt/ZIP/selected record hashes и пределы вывода. Исходные ZIP сверены по длине/digest/CRC. Optimized release API36 дошёл до самостоятельного ftrace blocker REL-003 (`eventsEnabled=X`, mutation=false), поэтому зависимый soak был skipped. Эта запись закрывает конкретную REL-009 корректировку и не заменяет full main-push release acceptance.
