# Screenshots and capture sources

The [English](../../README.md#screenshots) and [Russian](../../README.ru.md#скриншоты) READMEs use reviewed desktop and Android captures from the passing preview build. All seven current PNGs were extracted from CI, inspected individually and copied without pixel edits. The earlier Windows images remain historical references.

## Windows 0.4.1-rc.3

The desktop captures come from the **built production renderer in Chromium**, exercised by [`test/ui.browser.mjs`](../../test/ui.browser.mjs). The test injects an in-memory IPC fixture: server names, addresses, availability, latency and the master-switch state are synthetic. No native engine or remote public server is used to produce these images.

The three current desktop PNGs were extracted from the passing [Windows job](https://github.com/INNVoices/waarp/actions/runs/44276974976/job/134708014209) for [commit `f66e5def3d68`](https://github.com/INNVoices/waarp/commit/f66e5def3d689837db010c3453086a832c701fcc), reviewed individually and copied without editing their pixels.

| Gallery file | Captured state | Original test capture |
| --- | --- | --- |
| [server-picker.png](server-picker.png) | One selected public server; 1240 × 780 viewport | `app-public-server-picker.png` |
| [public-server-pages.png](public-server-pages.png) | 12 rows from a 257-node fixture; search, filters and pages; 1240px wide | `app-public-server-picker-pages.png` |
| [saved-server-pages.png](saved-server-pages.png) | 10 rows from a 160-profile fixture with synthetic city/server names; pages; 900px wide | `saved-server-picker-pages.png` |

The long-name regression runs unchanged and keeps its separate `route-picker-long-labels.png` stress capture. Only after those assertions and that capture does the saved-server gallery substitute readable `Example · City NN` names; profile IDs, counts, selected route and fixture latency remain the same.

For the two paginated captures, the test increases the real viewport height to include the entire scrollable page, resets scrolling and moves the pointer away from controls. Application styles and rendered contents are unchanged. The README displays smaller linked images; opening one preserves the full-resolution view.

These screenshots demonstrate the interface and its handling of populated lists. Fixture availability is not evidence that a third-party server works, and a renderer screenshot is not a native VPN acceptance result. The [server-selection notes](../SERVER-SELECTION-2026-11-18.md) describe the behavior; [release status](../RELEASES.md) is tracked separately.

## Android 0.5.0-rc.4

The Android images are captured from the native Compose application by [`MobileUiInstrumentedTest`](../../android/app/src/androidTest/java/local/waarp/android/ui/MobileUiInstrumentedTest.kt), using UI Automator screenshots. The [preview workflow](../../.github/workflows/release-preview.yml) runs this gallery on an **API 35, x86_64, Pixel 6 emulator profile** with software graphics. The scenarios use synthetic local test profiles and keep the VPN off.

All four 1080 × 2400 PNGs came from the passing [Android job](https://github.com/INNVoices/waarp/actions/runs/44276974976/job/134708014060) for the same [commit `f66e5def3d68`](https://github.com/INNVoices/waarp/commit/f66e5def3d689837db010c3453086a832c701fcc). The three gallery scenarios passed without failures or skips, after the five route/feedback scenarios. The main README shows Home, Settings and Groups.

| Gallery file | Screen | Original instrumentation capture |
| --- | --- | --- |
| [android-home.png](android-home.png) | Empty home screen | `01-home-empty.png` |
| [android-settings.png](android-settings.png) | Routing settings | `02-settings.png` |
| [android-route.png](android-route.png) | Saved custom test route after validation; earlier expected input-error notice is still visible | `03-saved-route.png` |
| [android-groups.png](android-groups.png) | Saved connection group with its success notice | `04-groups.png` |

The route capture belongs to a scenario that deliberately rejects invalid input, corrects it and verifies persistence. It shows the saved `UI custom route` and the earlier “Некорректный IP или подсеть” notification. It is retained here as a validation-state reference, rather than included in the main presentation strip. The group capture includes the normal “Группа сохранена” message. Neither notification was removed from the image.

The instrumentation checks that the application owns the foreground window when capturing. Individual review confirmed complete app frames with no system dialog or personal information. Emulator captures do not establish physical-device performance or remote tunnel connectivity.

## Historical Windows captures

The four original files remain available. They predate the current server picker and are not used as evidence of its layout.

| File | Earlier UI context |
| --- | --- |
| [hero-home.png](hero-home.png) | Main overview |
| [routing.png](routing.png) | Route assignment |
| [add-connection.png](add-connection.png) | Connection import/add |
| [diagnostics.png](diagnostics.png) | Direct and tunnel diagnostics |

## Refreshing the gallery

1. Capture the built production renderer or native Android app. Keep the original CI capture and source revision available with the run; generated illustrations are not application screenshots.
2. Use synthetic profiles and inspect every image for credentials, subscription links, tokens, personal paths, private endpoints and notifications.
3. Keep original PNG contents. A larger viewport may expose a full list; do not hide errors, replace results, or recolor the interface to improve the picture.
4. Review the exact files that will be committed, check that all README image links resolve, and update the build, platform and capture mapping above when they change.
5. Update both language READMEs together. Keep screenshot descriptions separate from test conclusions and download availability.
