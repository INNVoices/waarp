# Bundled engine: provenance and source

Waarp ships the engine as a separate program. Waarp talks to it over a local process boundary and a generated
config file; Waarp's own code is not linked into it.

| | |
|---|---|
| Program | sing-box-lx (fork of sing-box by SagerNet / nekohasekai) |
| Version | `1.14.2-lx.11` (reported by `sing-box.exe version`) |
| Source tag | `v1.14.2-lx.11` |
| Source commit | `3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d` |
| Source | https://github.com/Leadaxe/sing-box-lx/tree/v1.14.2-lx.11 |
| Upstream release | https://github.com/Leadaxe/sing-box-lx/releases/tag/v1.14.2-lx.11 (asset `sing-box-1.14.2-lx.11-windows-amd64.zip`, sha256 `0a63389570c675aa7a8820c0e0a61fa8c7a7f3346dcec9773b67bbcfc551bc85`) |
| License | see [`LICENSE`](LICENSE) in this folder: GPL-3.0-or-later text plus an additional naming / association condition from upstream |

Files shipped (sha256, also pinned in `integrity.json` and checked before every start). The binaries are not
tracked in Git; they are fetched and verified with:

```
npm run engine:fetch      # downloads the asset above, checks the archive sha256, extracts sing-box.exe + libcronet.dll,
                          # checks both against integrity.json; writes nothing on any mismatch
npm run engine:verify     # checks engine/sing-box.exe and engine/libcronet.dll against integrity.json (no network)
```

`npm run dist` and `npm run pack` run `engine:verify` first and stop if a file is missing or does not match.
Ordinary `typecheck`, `test` and `build` never download anything. To use an archive you already have:
`node scripts/engine.mjs fetch --archive <path-to-zip>` (the same archive checksum applies).

Verified 2026-10-05: both files are byte-identical to the ones inside the upstream asset above (the asset itself matches GitHub's published sha256 digest).

| file | sha256 |
|---|---|
| `sing-box.exe` | `1bf6c329963fbb6e4e80079f28e2079c0a6c3a860e8bdecf9a4dfc7f5bfa6b0f` |
| `libcronet.dll` | `3217c6260fbca5f16072e0b79735742f40109a63bb0ff88fd6b96dd6b54a2928` |

## Cronet (`libcronet.dll`)

Chromium's Cronet network stack, loaded by the engine at runtime for the naive outbound.

| | |
|---|---|
| Go binding pinned by the engine | `github.com/sagernet/cronet-go @ 0d28acc44093df24b2526dea3d6ffefd6b0a54f0` |
| DLL module | `github.com/sagernet/cronet-go/lib/windows_amd64 @ c10c03c318db6d47bec8705c8290bad34bc32b64`, path `lib/windows_amd64/libcronet.dll`; byte-identical to the shipped file |
| Built from | cronet-go `049f2909701ca088c9569f6b303bba5376a2b2ff` → submodule https://github.com/SagerNet/naiveproxy @ `72a06c9fca0e2d228588c7f3074bf7efff3ff686` (Chromium 150.0.7871.63) |
| Notices | [`CRONET-NOTICES.txt`](CRONET-NOTICES.txt): every LICENSE / COPYING / NOTICE file of that naiveproxy tree, by path (Chromium BSD-3-Clause, BoringSSL, QUICHE, zlib, zstd, brotli, abseil, ICU, libc++ and others) |

Electron's `LICENSES.chromium.html` covers Electron's own Chromium only; it is not used as the notice set for this DLL.

## Corresponding source

Each Waarp release that bundles the engine attaches `sing-box-lx-1.14.2-lx.11-src.tar.gz`
(sha256 `cfe0234e422a61d5ace36798e76b2466e6773565745c493925fd14aafbfb615c`): the engine commit above **with the
four `go.mod` local-replace submodules populated** at their gitlink SHAs, plus `WAARP-SOURCE-MANIFEST.txt`:

| path | repository | commit |
|---|---|---|
| (root) | https://github.com/Leadaxe/sing-box-lx | `3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d` |
| `submodules/wireguard-go` | https://github.com/Leadaxe/wireguard-go-awg2-lx | `64065e6826ad82aa28429dd829c1c65f29b7f6c9` |
| `submodules/sing-tun` | https://github.com/Leadaxe/sing-tun-lx | `6f56eca9cb2e81d1c233b6104618ff30500e9f39` |
| `submodules/gvisor` | https://github.com/Leadaxe/gvisor-lx | `117243aa02fa2915cb53d1d4549bfca3a3ebf238` |
| `submodules/utls` | https://github.com/Leadaxe/utls-lx | `59e89bb121d8cc7a0a1c87a930864122b5685d00` |

Client submodules (`clients/*`) are not part of the Windows engine and are not included. Other Go dependencies
are the versions pinned in the bundled `go.mod` / `go.sum`. The plain GitHub commit archive
(`sing-box-lx-3d3d3db.tar.gz`, sha256 `1ed720a9a59dbe055319be2506c439eda6ecaf69cf28c72c91727ecbe4bae095`) is
provenance only: it lacks the submodule worktrees. This file records what is shipped; it is not a legal conclusion.

Waarp does not use the sing-box name for itself and does not imply association with or endorsement by the
sing-box or sing-box-lx authors.
