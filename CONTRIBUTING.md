# Contributing to Waarp

Found a bug? Open an issue. Know how to fix it? Send a pull request. Small, focused fixes are especially useful.

## Before you start

- One problem per pull request where practical.
- Explain the user-visible problem first, then the fix.
- Keep changes focused. Please no unrelated refactors.
- For bug fixes, add or update a regression test when practical.

## Checks

Run the normal offline checks before submitting:

```
npm run typecheck
npm test
npm run check
npm run build
```

Packaging (`npm run dist`, `npm run pack`, `build.bat`) needs the engine binaries, which are not stored in Git:
run `npm run engine:fetch` once (pinned download, checksum-verified), see `engine/SOURCE.md`. The checks above never download anything.

Do not run `npm run test:live` on a machine you care about. It changes the network
configuration and is only meant for a disposable machine. Please do not change
live network tests to run elsewhere either.

## Keep secrets out

Never include real VPN keys, subscription URLs, tokens, private server addresses,
personal paths or other private data in code, tests, logs, screenshots or issues.
Use obviously fake placeholders instead.

## UI changes

Add screenshots for any visible UI change.

## Review and merge

- Maintainers may edit the title and squash your commits into one clean commit.
  Your authorship is kept.
- Not every PR will be merged, but every honest attempt is appreciated.

## Tools

You can use whatever workflow you like, with or without AI tools. You are
responsible for what you submit, so please read and understand your own change.

## Security problems

Please do not open a public issue for vulnerabilities. See [SECURITY.md](SECURITY.md).
