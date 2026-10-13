# Contributing

Thanks for helping out!

## Getting started

```bash
npm install
npm start           # build and run
npm run check       # type-check, lint, unit tests, and build: run before opening a PR
npm run smoke       # optional: end-to-end runtime checks against the real app
```

## Guidelines

- **Keep privileged code in `src/main/`.** Renderers must never get Node, filesystem, or unrestricted IPC access. New IPC channels need an entry in `src/shared/ipc-policy.ts`, a validator for the payload, and a matching method in the preload bridge. `tests/ipc-and-validation.test.ts` checks that these stay in sync.
- **Put pure logic in `src/shared/`** with unit tests. This covers state transitions, math, parsing, and validation.
- **Avoid busy loops.** Use one timer per concern and clear it on every state change. `tests/companion-controller.test.ts` checks that pausing leaves no timers behind.
- **Keep dependencies focused.** Explain why a new one is needed in the PR.
- **Respect privacy.** Don't add telemetry, background monitoring, or anything that reads files, clipboard, keystrokes, or other apps.
- **Label sources honestly.** Offline or scripted text must never be presented as coming from Claude.

## Artwork

Read [ARTWORK.md](ARTWORK.md) first. Contribute only artwork you created or that is licensed for redistribution, with its license and attribution. Never mark fan art or generated art as official Clawd art.

## Commits and PRs

- Write descriptive commit messages, such as "Clamp companion to work area on display removal".
- Don't commit secrets, `.env` files, local settings, build output, or personal information. Check `git diff --staged` before you commit.
