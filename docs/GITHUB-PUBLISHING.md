# GitHub repository presentation

The repository's Markdown presentation, SVG cover, screenshots, release template and prerelease workflow live in Git. The **About panel, topics, social preview, Discussions, visibility and branch rules are repository settings**, not Markdown files. These settings require an authenticated administrator in the GitHub UI or a repository-administration API capability.

## Proposed About metadata (copy exactly)

**Description**

> Waarp — open-source per-app traffic routing for Windows & Android. Bring your own VPN/proxy, use sticky failover, diagnose paths and explore an opt-in public node pool.

**Website:** leave blank until a real owned website or GitHub Pages URL is published. Never use a placeholder.

**Topics:** `vpn`, `proxy`, `traffic-routing`, `wireguard`, `amneziawg`, `sing-box`, `electron`, `android`, `kotlin`, `windows`, `networking`, `open-source`

**Social preview:** use a real 1280×640 PNG export of [the branded SVG](brand/waarp-cover.svg) with correct padding. The SVG is a README banner, not an automatically installed GitHub social preview. Avoid uploading an unverified fake screenshot.

**Recommended repo settings after public-readiness review:** enable Releases, Issues and security reporting; enable Discussions if the community has moderation capacity; add branch rules requiring functional checks before merge; consider a signed release provenance attestation when the distribution pipeline supports it. Do **not** make the repository public just to make a badge work — review embedded data, licenses, bundled dependencies and secrets first.

## Repository surface checklist

- [x] Branded English/Russian README
- [x] Existing desktop screenshot gallery with a privacy policy for new captures
- [x] License, security policy, contribution guide and support entrypoint
- [x] Documentation index and version-specific download matrix
- [x] GitHub auto-generated release-note category configuration
- [x] RC release notes, release intent manifest and reproducible preview workflow
- [ ] About description/topics and social preview set in repository settings
- [ ] Actual sanitized Android device screenshots committed
- [ ] Production-signed Android APK and stable acceptance
- [ ] Public visibility (only after owner approval and secret/legal review)

## Release workflow behavior

Adding [the initial release intent](../release/preview-2026-11-18.json) to main triggers an attempt to prepare a draft prerelease and build both platforms. The draft becomes visible as a prerelease only if both jobs succeed. See [RELEASES.md](RELEASES.md) for exact validation and limitations.

For future preview candidates, update the workflow's pinned version checks and release intent deliberately. Do not reuse an old tag for new bytes.