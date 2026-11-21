# Portable lifecycle acceptance

`scripts/test-portable-lifecycle.mjs` is one bounded Windows scenario for REL-007. Run it **after** `package:verify`, on the same disposable GitHub-hosted Windows job and source checkout:

```powershell
node scripts/test-portable-lifecycle.mjs --disposable-windows
```

It writes `out/validation/portable-lifecycle.json` on success, refusal or failure, and exits nonzero unless all three planned launches pass. The scenario has a 240-second budget, including a cleanup reserve; it does not restart a failed launch or extend the enclosing Windows job timeout. Linux execution records `NOT_RUN`, never a Windows pass.

## What the scenario exercises

1. Copy the verified `Waarp-<version>-portable.exe` unchanged to a private temporary directory. Start the actual portable wrapper and let it extract its application. Require an empty isolated profile store, packaged renderer, ready startup recovery and VPN master OFF.
2. Through the existing UI, manually import one synthetic VLESS profile at `127.0.0.1:9`, then disable “Minimize to tray” and notifications. Auto-connect and autostart remain disabled. The harness does not activate VPN, import a public server or install a route.
3. Close the existing window close button. Require wrapper exit code 0 and absence of observed owned processes. Launch the same EXE again; require the same profile identity and settings, then close normally again.
4. With the owned processes stopped, replace the EXE with a new copy of the **same candidate bytes**. Launch for the third and final time, verify persistence again, then close normally.

The test reads the product's existing `snapshot` IPC and encrypted store but does not write the store, decrypt profiles itself, inject preload code, modify ASAR, substitute network responses or add product test hooks. UI mutations use ordinary visible controls. The stored profile must use the `e:` encrypted envelope; Windows secure storage must be available, and the real app must restore the profile on launches 2 and 3. This demonstrates same-account persistence through the application's DPAPI path, not resistance to a different Windows account or machine.

## Identity and isolation

The original EXE hash and size must match `package-integrity.json`, bound to `GITHUB_SHA` and the package version. Each running application must identify the copied portable wrapper, and its OS process must be a direct child of that wrapper. The extracted ASAR hash must equal the ASAR verified before launch. Original build files are checked unchanged after the scenario.

The standard Electron `--user-data-dir` switch selects a new private directory. Its actual value is read back from `app.getPath('userData')`; a different value fails acceptance before UI mutations. `TEMP`/`TMP` isolate extraction, and `LOCALAPPDATA` isolates Waarp's portable engine cache. Standard loopback Node inspector and Chromium CDP transports provide observation and UI automation. No debug transport is added to the product.

Electron's pinned [`v44.11.3` startup implementation](https://github.com/electron/electron/blob/v44.11.3/shell/app/electron_main_delegate.cc) applies `--user-data-dir` before the application starts. The [Electron switches documentation](https://www.electronjs.org/docs/latest/api/command-line-switches) documents remote debugging; [Playwright's CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) attaches to an existing Chromium target. The [electron-builder portable contract](https://www.electron.build/v26/docs/nsis/#portable) exposes `PORTABLE_EXECUTABLE_FILE`. These mechanisms explain the harness; the runtime identity and byte checks determine whether this candidate actually meets them.

Process ownership uses the private directory, observed PID + creation timestamp + executable identity, and live owned ancestry. Process names alone are insufficient. A failed scenario may terminate only individually revalidated owned processes through pinned process handles; forced cleanup never counts as normal exit. The report excludes unrelated process inventories and profile ciphertext.

## Explicit limits

- **UAC consent/refusal: NOT_RUN.** No elevation is requested. A hosted runner may already be elevated, so absence of a UAC prompt proves neither consent nor refusal.
- **Different-version upgrade, migration and rollback: NOT_RUN.** Same-candidate replacement tests a stopped portable file replacement and persistence only.
- **Sleep/resume, physical network changes, interaction with another VPN: NOT_RUN.** These require separate environments and evidence.
- **VPN/TUN routing and public connectivity: NOT_RUN in this scenario.** Existing native lifecycle/selector acceptance remains separate. Normal background probes may occur even with the master OFF; this is not an offline test.
- **Installer uninstall and ordinary-user ACL behavior: NOT_RUN.** A portable wrapper and disposable CI account do not establish those outcomes.

Guard/receipt tests can run without Windows:

```sh
node --test scripts/test-portable-lifecycle.test.mjs
```

Their result verifies harness refusals and process-identity logic only. REL-007 remains open until actual Windows evidence and its other outstanding acceptance items have been reconciled.
