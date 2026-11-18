Windows and Android share source release **1.0.0**.

- **Windows 10/11 x64** · Download the portable EXE and verify its SHA-256 against the attached list. The executable is unsigned.
- **Android 10+** · Choose the debug APK for your device (ARM64 for most phones). These packages use a developer signature and a separate application ID. A debug APK from a different signing key cannot update an existing debug install. Build all three debug APKs with `build.bat apk` on Windows. The source archive includes the pinned native library. Initial Gradle, Maven and minimal SDK downloads are required. Production-signed APK distribution requires the existing update identity.

[Build and component guide](https://github.com/INNVoices/waarp/blob/v1.0.0/docs/V1.md) · [Русский](https://github.com/INNVoices/waarp/blob/v1.0.0/README.ru.md)
