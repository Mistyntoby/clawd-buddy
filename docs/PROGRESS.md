# Progress log

## 2026-10-13: Claude subscription option

- Added a second way to reach Claude: **Settings → AI → Connect with → Claude subscription (Claude Code)**. Each message runs the locally installed `claude -p` with streaming JSON output, no tools, `--safe-mode`, no session persistence, and an empty working folder. Earlier turns are sent as a transcript in the prompt. `ANTHROPIC_API_KEY` is stripped from the CLI's environment so it uses the subscription.
- *Test connection* uses `claude auth status`, which costs no usage, and reports the plan.
- Verified live against a Claude Pro sign-in, outside Electron, by calling the backend module directly: streamed reply with conversation context, *Stop* (abort after 4 deltas gives `AbortError`), and an invalid model producing the friendly "can't use that model" error. "Not signed in" output was checked against the CLI using an empty config folder.
- Not yet verified: a live subscription chat from inside the running Electron app (the smoke test only checks that the option can be selected and stays offline while AI is disabled). It's on the manual checklist.
- Tests: 105 unit tests, 22 smoke checks, all passing.

## 2026-10-13: v0.1.0 first release candidate

### Initial findings (Phase A)

- **Environment:** Windows 11, Node 24, npm 11, Git 2.53, and an authenticated GitHub CLI.
- **Workspace:** Started from an empty directory, so there was no existing work to preserve.
- **Tooling:** typescript-eslint doesn't yet support TypeScript 7, so TypeScript is pinned to 6.0.
- **Clawd assets:** I found no official, Anthropic-controlled distribution of Clawd sprites or animations with redistribution terms. The reference article cites no asset source or license. Community fan tools license their code under MIT and treat the character as Anthropic's IP. **Decision:** don't bundle any Clawd art. Instead there's an asset-provider system that loads local packs, plus an original, clearly labeled placeholder ("Pip"). Details are in ARTWORK.md.
- **Repository identity:** A repo-local commit author ("Clawd Buddy", using a reserved `.invalid` address) keeps commits neutral. Global git config is untouched.

### Completed

- Hardened Electron app: context isolation, sandbox, CSP, per-window IPC allow-list with payload validation, blocked navigation and permissions, and a single-instance lock.
- Transparent, click-through companion window with drag, multi-monitor clamping, recovery when displays change, auto-hide taskbar handling, and position memory.
- Deterministic behavior state machine (9 states) with timers for wandering, sleeping when the user is away, one-shot reactions, and speech.
- Sprite system: manifests with frame lists or sheets, path-safe `clawd-asset://` protocol, fallback chains, diagnostics, and an emergency shape if there are no sprites at all.
- Context menu, tray menu, speech bubble (wraps, clamps to the window, shows its source), and synthesized sounds.
- Chat: streaming Claude replies, Stop/cancel, history trimming, friendly error mapping, refusal handling, and offline brain responses that are always labeled.
- Settings: behavior, AI key (safeStorage), model, memory (opt-in, with an approval card), sprite diagnostics, reset, and quit. Launch at startup is disabled with an explanation when running from source.
- Tests: 91 unit tests, plus a 21-check smoke test that passes on both the dev build and the packaged build (counts as of this release; see the newer entry above).
- Windows NSIS installer builds with `npm run dist`.

### Issues found and fixed during verification

- The speech bubble overflowed the top of the window: missing `box-sizing` and `pre-wrap` on the container. It now clamps lines to the available space, and a smoke check covers it.
- On a machine with an auto-hide taskbar, the taskbar covered the companion's feet. Added `effectiveWorkArea` and a smoke check that the window is fully inside the usable area.

### Known limitations

- **No live Claude reply was verified**, because no API key was available while building. The real SDK path was exercised against the live API with an invalid key and correctly produced the friendly "key rejected" error. Request parameters follow the installed SDK's typings. Run the Claude section of `docs/MANUAL_TESTING.md` with a real key.
- Native context menus, tray menus, and real mouse drags aren't automated. See `docs/MANUAL_TESTING.md`.
- Fullscreen detection: Windows offers no reliable way to detect other apps' fullscreen state without native code. To mitigate, ambient comments are rare (every 25–50 minutes), silent, never take focus, and only appear when the user is active and the companion is idle and visible. Turn them off in Settings.
- The installer is unsigned, so SmartScreen will warn.
- macOS hasn't been tested. The code avoids Windows-only APIs except the tray balloon, which is guarded.

### Next steps

- Verify Claude chat with a real key, following the manual checklist.
- Add a "peek" behavior (sitting on window edges) and more animations.
- Add a macOS build target and test it.
- Add optional code signing.
