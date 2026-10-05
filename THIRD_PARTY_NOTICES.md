# Third-party notices

Components redistributed in the Waarp Windows build, with their licenses. Full license texts ship with each
component, inside the portable build:

- `resources/engine/LICENSE` and `resources/engine/CRONET-NOTICES.txt` (sing-box-lx and the Cronet DLL);
- `resources/licenses/<package>/` with the license file copied unchanged from the installed npm package, for
  every bundled runtime package listed under "Application runtime" below (React, react-dom, scheduler, jsQR,
  Simple Icons, Instrument Sans, Inter, JetBrains Mono);
- `LICENSES.chromium.html` next to the executable (Electron's own Chromium) and `LICENSE.electron.txt` (Electron).

The engine binaries are not stored in this Git repository. They are release/build inputs: `npm run engine:fetch`
downloads the pinned upstream archive, checks its SHA-256 and the two extracted files against
`engine/integrity.json`, and `npm run dist` refuses to package without them.

## Engine (separate program)

| component | version | license | where |
|---|---|---|---|
| sing-box-lx | 1.14.2-lx.11 | GPL-3.0-or-later + upstream naming condition, see `engine/LICENSE` | `engine/sing-box.exe` (fetched, not in Git) |
| Chromium Cronet (cronet-go lib/windows_amd64 @ c10c03c, Chromium 150.0.7871.63) | as shipped by sing-box-lx 1.14.2-lx.11 | BSD-3-Clause + Chromium third-party licenses, full set in `engine/CRONET-NOTICES.txt` | `engine/libcronet.dll` (fetched, not in Git) |

Provenance, hashes and corresponding source: [`engine/SOURCE.md`](engine/SOURCE.md).

## Application runtime

| component | version | license |
|---|---|---|
| Electron (incl. Chromium, Node.js) | 44.x | MIT; Chromium and Node.js third-party licenses in `LICENSES.chromium.html` |
| React, react-dom | 19.3.0 | MIT |
| scheduler | 0.28.0 | MIT |
| jsQR | 1.4.0 | Apache-2.0 |
| Simple Icons | 16.33.0 | CC0-1.0 (brand icons stay trademarks of their owners) |
| Instrument Sans (via @fontsource-variable) | 5.x | SIL Open Font License 1.1 |
| Inter (via @fontsource) | 5.x | SIL Open Font License 1.1 |
| JetBrains Mono (via @fontsource-variable) | 5.x | SIL Open Font License 1.1 |

Build-only tools (electron-builder, electron-vite, Vite, esbuild, TypeScript) are not redistributed.

## Public catalog data

Waarp does not ship public node lists. The optional public catalog downloads them at runtime from the sources
listed in [`docs/SOURCES.md`](docs/SOURCES.md). Those nodes are run by third parties, not by Waarp.
