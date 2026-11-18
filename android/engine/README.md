# Android native library

`libbox.aar.xz` is a lossless XZ copy of the canonical AAR described by [engine_integrity.json](../app/src/main/res/raw/engine_integrity.json). The APK build restores it into the ignored `app/libs/` directory. To reproduce the library from source, follow [the native source lock](../native-source.json) and [build recipe](../../scripts/android-core-build.py). The matching [native patches](../native-patches/), [upstream license and component notices](../app/src/main/assets/licenses/) and [Android project license](../LICENSE) are included.

On a native-core update, rebuild the canonical AAR, update the source and integrity pins, then replace the compressed copy. Verify restoration with `node scripts/android-core.mjs fetch` in a clean checkout.
