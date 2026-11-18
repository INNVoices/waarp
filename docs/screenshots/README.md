# Screenshot gallery and capture policy

The [README](../../README.md#screenshots) uses the four existing **Windows** captures in this directory:

| File | UI context |
| --- | --- |
| [hero-home.png](hero-home.png) | Main overview |
| [routing.png](routing.png) | Route assignment |
| [add-connection.png](add-connection.png) | Connection import/add |
| [diagnostics.png](diagnostics.png) | Direct and tunnel diagnostics |

They were already committed before this presentation update. They are not proof that the latest release-candidate UI is visually identical.

## Adding Android or fresh Windows screenshots

1. Capture the actual production renderer or Android device/emulator; avoid generated mockups passing as application screenshots.
2. Hide **VPN credentials, subscription URLs, tokens, private IP/host names, personal paths and notifications**. Use synthetic local test profiles when possible.
3. Prefer high-DPI PNG with stable aspect ratio; crop unused desktop space without hiding errors or misleadingly altering app contents.
4. Use descriptive names such as `android-home.png`, `android-routes.png`, `android-tunnels.png`, `android-diagnostics.png` and include exact build version, platform and device in this file.
5. Review every image before public commit. Update both language READMEs and give each capture an accurate label. Do not silently replace screenshots with promotional illustrations.

Android screenshots are intentionally not included until real, sanitized device captures exist.