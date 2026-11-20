# Distribution configuration

This directory contains optional installation helpers for the published Waarp previews. [User installation guide](../INSTALL.md).

## Files and status

| File | Purpose | Verification status |
| --- | --- | --- |
| [obtainium.json](obtainium.json) | Importable Android preview configuration; top-level `apps` array | JSON structure, current GitHub release selection and all three ABI filenames checked against Obtainium v1.7.4 source |
| [obtainium-link.txt](obtainium-link.txt) | The same entry encoded as an `obtainium://app/` link for the project website | Decodes to the exact entry in `obtainium.json` |
| [waarp-preview.json](waarp-preview.json) | Pinned Scoop manifest candidate for Windows r6 | JSON, official asset URL and GitHub asset digest checked; Windows install/update/uninstall not run |

These checks do not establish an on-device Obtainium installation or a tested Scoop package. Neither file claims inclusion in an external app catalog or official Scoop bucket.

## Obtainium configuration

The file uses Obtainium's supported `{"apps": [...]}` import envelope. Each entry's `additionalSettings` is a JSON **string**, as expected by `App.fromJson`, rather than a nested object.

The entry tracks `local.waarp.android.debug`. `allowIdChange` remains false. It does not move an installation to `local.waarp.android`, sign an APK or replace a signing key.

The non-default release settings have specific purposes:

- `includePrereleases: true` includes the published preview channel.
- `includeDrafts: false` excludes unpublished releases.
- `fallbackToOlderReleases: true` continues searching when a newer release has no eligible APK.
- `sortMethodChoice: "date"` selects by publication date, not by sorting mixed platform version strings.
- `verifyLatestTag: false` avoids relying on GitHub's stable-only `/releases/latest` selection.
- `apkFilterRegEx` accepts only filenames in the Waarp Android debug family and the three distributed ABIs.
- `autoApkFilterByArch: true` delegates ABI choice to Obtainium using the Android device's supported ABI list.
- ZIP/tarball inclusion and tracking-only mode are disabled.

At the check on **20 November 2026**, the newest public release was Windows-only `preview-2026-11-18-r6`. It had no matching APK. The next matching release was `preview-2026-11-18-r5`, with exactly one file for each of `arm64-v8a`, `armeabi-v7a` and `x86_64`.

This was verified by applying the source's release exclusion, date ordering and filename-selection conditions to the live GitHub release metadata. It was not a Flutter runtime or Android device test. Importing still requires the user's confirmation, and installation uses Android's normal installation approval.

### Website link

Read the single app entry from `obtainium.json`, serialize it without indentation, and encode it:

```js
const app = configuration.apps[0];
const href = 'obtainium://app/' + encodeURIComponent(JSON.stringify(app));
```

The checked result is in `obtainium-link.txt`. Present it as **Import Android preview into Obtainium** with a nearby link to [manual setup](../INSTALL.md#obtainium). A custom URI requires Obtainium to be installed and a browser that hands the URI to Android. It is not a silent installation.

GitHub Markdown may not retain a custom-protocol link. The README should link to the installation guide instead. The project website can use the direct URI and keep the file/manual fallback available.

### Updating this configuration

1. Recheck the public release assets and package identity.
2. Keep the debug and production update channels separate. Switching from a debug package to production requires an explicit migration plan and the correct production signing identity.
3. Change the APK filename filter only when the distributed filenames change; retain the ABI and package distinctions.
4. Regenerate `obtainium-link.txt` from the JSON entry and update the website link in the same change.
5. Check selection against a newer release without Android assets as well as a release that contains all supported APKs.
6. Test import, installation and an update on Android before describing the integration as device-verified.

### Upstream references

- [Obtainium v1.7.4 release](https://github.com/ImranR98/Obtainium/releases/tag/v1.7.4)
- [GitHub release filtering and fallback](https://github.com/ImranR98/Obtainium/blob/v1.7.4/lib/app_sources/github.dart)
- [App JSON fields](https://github.com/ImranR98/Obtainium/blob/v1.7.4/lib/models/app.dart)
- [File import envelopes](https://github.com/ImranR98/Obtainium/blob/v1.7.4/lib/providers/apps_provider_import_export.dart)
- [Deep-link confirmation and import](https://github.com/ImranR98/Obtainium/blob/v1.7.4/lib/pages/home.dart)
- [APK filename and ABI filtering](https://github.com/ImranR98/Obtainium/blob/v1.7.4/lib/services/apk_filter_service.dart)
- [Official deep-link documentation](https://wiki.obtainium.imranr.dev/deep_links/)

## Scoop manifest candidate

`waarp-preview.json` pins the public Windows r6 portable EXE and its SHA-256. It has no automatic update rule: later binaries should be reviewed and tested before changing this candidate. The manifest does not move user configuration or claim portable data persistence.

The `Apache-2.0` field describes the Windows application source. The bundled engine and dependencies retain their own notices; see [third-party notices](../../THIRD_PARTY_NOTICES.md).

Before recommending the manifest as an installation channel, validate it on a disposable Windows environment with Scoop:

```powershell
scoop install .\waarp-preview.json
```

Check the shortcut, launch, existing configuration, tunnel elevation, upgrade behavior and uninstall behavior. Do not run a competing full-route VPN during a tunnel test. Record which exact binary and environment were exercised.

For an external Scoop bucket submission, follow the [current contribution process](https://github.com/ScoopInstaller/.github/blob/main/.github/CONTRIBUTING.md), including the initial package proposal, maintainer review, the appropriate bucket for a preview and the required manifest/autoupdate checks. The file in this directory is not an accepted package.

## Download evidence

The installation guide and manifest use version-specific URLs and the `digest` fields from these public release API responses:

- [Windows r6 metadata](https://api.github.com/repos/INNVoices/waarp/releases/tags/preview-2026-11-18-r6)
- [Android r5 metadata](https://api.github.com/repos/INNVoices/waarp/releases/tags/preview-2026-11-18-r5)

The hashes identify the existing published assets. They do not represent a new build, signature or independent security audit.

## Search discovery

The Russian and English project pages have canonical URLs, reciprocal language links, social-preview metadata and a [sitemap](https://innvoices.github.io/waarp/sitemap.xml).

An [IndexNow](https://www.indexnow.org/documentation) verification file is served at `https://innvoices.github.io/waarp/76d937ea3bb5ebef15b2970b6e029ba6.txt`. This public key is limited to the `/waarp/` path through `keyLocation`. It is not a GitHub credential.

After the updated pages and key are publicly deployed, notify the IndexNow global endpoint with this JSON body:

```json
{
  "host": "innvoices.github.io",
  "key": "76d937ea3bb5ebef15b2970b6e029ba6",
  "keyLocation": "https://innvoices.github.io/waarp/76d937ea3bb5ebef15b2970b6e029ba6.txt",
  "urlList": [
    "https://innvoices.github.io/waarp/",
    "https://innvoices.github.io/waarp/en/"
  ]
}
```

Send it once using `POST https://api.indexnow.org/indexnow` and `Content-Type: application/json; charset=utf-8`. Submit again only when the relevant pages change. Check that the key URL returns the exact key before submitting. A successful notification means receipt by the service; it does not guarantee crawling, indexing, search position or visits. See the [official response-code guide](https://www.bing.com/indexnow/getstarted).
