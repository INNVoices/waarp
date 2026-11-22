# Android store metadata

`metadata/android/en-US/` and `metadata/android/ru-RU/` contain the Android listing in the standard Fastlane layout. Each locale has `title.txt`, `short_description.txt`, `full_description.txt`, `images/icon.png` and two files in `images/phoneScreenshots/`. The project name remains **Waarp**.

This is source metadata for distribution preparation. It does not publish an app or establish acceptance by F-Droid, IzzyOnDroid or Google Play. The currently published Android build is the debug-signed [1.0.0 preview](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2), actual APK version `1.0.0-debug`, version code `7`, package `local.waarp.android.debug`. All three APK certificates differ from the corresponding r5 APKs, so this preview cannot update r5 in place. It is suitable for a fresh installation on a device without r5; keep an existing r5 installation and its data. No production-signed APK is part of this release. See the [installation guide](../docs/INSTALL.md) and [release record](../docs/RELEASES.md#published-preview-2026-11-22-r2).

## Original assets

All image files are byte-for-byte copies of existing repository assets. There is no crop, resize, frame, translated overlay or generated image. The English and Russian descriptions are localized; both locales deliberately retain the original Russian-language screenshots. The descriptions state this explicitly.

| Metadata filename in each locale | Repository source | Dimensions | SHA-256 |
| --- | --- | --- | --- |
| `images/icon.png` | [`build/icon.png`](../build/icon.png) | 256 × 256 | `01a99a4f98bf59024cdbd8b7b2fb0ce4b9870125008273a3b5c61817cde30052` |
| `images/phoneScreenshots/01-tunnels-map.png` | [`android-atlas-normal.png`](../docs/screenshots/preview-r5/android-atlas-normal.png) | 1080 × 2400 | `27225cac611aa2b176618ca0f4b1f5a982ebeb6ed235359f95aac20bcfb7c5ee` |
| `images/phoneScreenshots/02-tunnels-map-large-text.png` | [`android-atlas-150.png`](../docs/screenshots/preview-r5/android-atlas-150.png) | 1080 × 2400 | `e605ad00c826453dd138c18e3ea8ca0d3f1835d0390194f038ba91564885a99e` |

The icon is the project's existing orange W on a dark background. The two screenshots were captured from the native Compose/MapLibre application at commit [`928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`](https://github.com/INNVoices/waarp/commit/928c9a8e3cd0a83a41ebfa15c2628ddb610ea157), Android `0.5.0-rc.5-debug`, version code 6. The capture used an Android 15 / API 35 x86_64 emulator, synthetic offline profiles and an inactive VPN. The second capture uses 150% font scaling. [Existing capture provenance](../docs/screenshots/preview-r5/android-provenance.json) and the [gallery record](../docs/screenshots/preview-r5/README.md) retain the original CI job and checks. These images establish UI appearance, not remote connectivity or physical-device performance.

## Format limits and remaining distribution work

- Text files use UTF-8, LF line endings and plain text. The title is limited to 30 characters, the short description to 80 and the full description to 4,000. The title limit is stricter than F-Droid's documented 50 and matches IzzyOnDroid/Google Play guidance.
- PNG is supported by the referenced metadata formats. The existing 256 × 256 icon is within IzzyOnDroid's documented 48–512 pixel range. Google Play requires a separate 512 × 512 store icon.
- The original screenshots have a 20:9 aspect ratio (2400 / 1080 = 2.222…). They exceed Google Play's maximum 2:1 screenshot ratio and the ratio check described by IzzyOnDroid's recommended Fastlane validator. F-Droid's source metadata documentation accepts PNG screenshots without specifying that ratio limit; this change does **not** claim that the image set passes strict Play/Izzy validation. Capture the real app at a suitable viewport before using those targets. Do not stretch, crop or add padding to these evidence files merely to hide the mismatch.
- No changelog directory is added. A future release note must correspond to the actual published APK version code. F-Droid and IzzyOnDroid generally read source metadata at the release/tag they process, so adding files to `main` does not retroactively change a tagged preview or guarantee an immediate listing update.
- A production release still needs the established package/signing identity and the existing release checks. The current debug APKs do not meet IzzyOnDroid's ordinary release-key/non-debuggable rule and are larger than its usual 30 MB APK allowance. Metadata does not remove these requirements. See the [Android build and signing guide](../docs/ANDROID.md#build-and-install).

When publishing a real Android release, review the description's preview/version paragraph, capture provenance and asset limits together. Keep the Android GPL-3.0-or-later license and the separate Windows Apache-2.0 license accurate; dependencies retain their own notices.

## Primary format references

- [F-Droid: descriptions, graphics and screenshots](https://f-droid.org/en/docs/All_About_Descriptions_Graphics_and_Screenshots/) — root locations, filenames, fallback locale, text limits, image formats and release metadata selection.
- [Fastlane supply: images and screenshots](https://docs.fastlane.tools/actions/supply/#images-and-screenshots) — locale directories, image filenames, `phoneScreenshots` and alphabetical ordering.
- [IzzyOnDroid: Fastlane](https://izzyondroid.org/docs/general/Fastlane/) — text/image guidance, screenshot handling and source-tag selection.
- [IzzyOnDroid: app inclusion policy](https://izzyondroid.org/docs/general/AppInclusionPolicy/) — metadata requirements and independent APK/signing/size requirements.
- [Google Play: store listing text limits](https://support.google.com/googleplay/android-developer/answer/9859152?hl=en) and [preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en) — stricter cross-store checks, not a claim of a Play submission.
- [Google Play: icon specifications](https://developer.android.com/distribute/google-play/resources/icon-design-specifications) — the required 512 × 512 store icon is distinct from an APK launcher icon.
