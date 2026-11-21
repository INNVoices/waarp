# Waarp agent entry

Read [the production map](docs/production/README.md) and the full card for your task before changing code. The task registry is `docs/production/tasks.json`.

```sh
python3 scripts/production-roadmap.py check
python3 scripts/production-roadmap.py ready
python3 scripts/production-roadmap.py show REL-001
```

These commands are read-only and reflect the checked-out snapshot. Confirm current `origin/main`, linked PRs, CI and ownership before claiming work. Use a separate branch/worktree for an independent implementation. The coordinator owns shared roadmap/registry edits within a wave; agree on exact paths before two agents edit a workflow, manifest or shared contract. The workflow is in `docs/production/08-agent-execution.md`.

## Preserve the product contract

- Waarp selects `target -> Direct / Auto / chosen personal connection` on Windows and Android. Preserve existing profiles, settings and package/update identities.
- A missing or revoked protected path must not silently become Direct or a public route. Do not broaden private Auto or companion paths to public endpoints.
- Existing implementation, unit tests, native validation and production acceptance are different facts. Reconcile existing Э0–Э8 / WN work before implementing something again.
- Keep changes scoped to proven-owned resources. Do not reset global Winsock/DNS or delete arbitrary adapters, other VPN state or user profiles.
- Keep secrets and third-party UI/traffic out of reports. Preserve notices, source provenance and integrity checks during cleanup.
- Android Sticky Entry is defined in `docs/ANDROID-CHAMELEON-2026-11-18.md` and corpus 04. A Windows tray/hotkey is not a substitute. Recovery precedes hiding an owned launcher entry; entry visibility does not change VPN state.

## Verify and integrate

Use existing harnesses and targeted regression checks appropriate to the changed risk. Do not claim a browser, emulator, physical-device, signing or release check that did not run. Keep failed evidence and distinguish infrastructure refusal from an application defect.

Use normal pull requests and required CI. Do not bypass protected main, skip mandatory checks, replace tests with weaker assertions or regenerate signing keys. A merged diagnostic helper does not authorize a stable release. Publication follows the acceptance policy in `docs/RELEASES.md` and corpus 01.

Keep task status, specification and evidence links consistent. `done` means the task's acceptance criteria are satisfied; a ready patch belongs in `review`. If an account, retained signing identity or physical environment is unavailable, record the precise blocker and continue other ready work. Do not repeatedly ask the user to authorize work already authorized in the session.
