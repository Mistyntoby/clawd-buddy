# Progress log

## 2026-10-14: Chat box color, drop bounce

- **Chat box color** (Settings → Behavior): eight presets plus a custom color picker. It colors the border of the input under Clawd and of his speech bubble (a brighter shade while you type). Validated as `#rrggbb`; swatch colors are set through CSSOM because the settings page's CSP forbids inline styles.
- **Drop bounce:** when Clawd is dropped he squashes, hops up about 22 px, and bounces lower each time (42% of the speed kept per touch-down), squashing a little at every impact, all in under half a second. It's a `translateY` plus `scale` transform on the sprite, so the window stays exactly at the drop point; picking him up again cancels it; scaled by animation intensity; off with Reduce motion. Smoke check measured a 21.7 px hop with an unchanged window position.
- Tests: 160 unit tests; 44 smoke checks on Windows.

## 2026-10-14: Live subscription chat verified in the app; to-dos and agenda

- **Verified live inside the running Electron app:** a real message through the local Claude Code subscription (Claude Pro) came back from Claude, labeled as Claude, and Clawd went from thinking to talking. This is an opt-in smoke check (`CLAWD_SMOKE_LIVE=1`), never run in CI.
- To-do list: `/todo`, `/todo <text>`, `/todo done|undo|forget N`, `/todo clear`, and a list with checkboxes in Settings → Reminders & to-dos (stored locally in `todos.json`). Ticking one off makes Clawd celebrate.
- Reminders are shown as an agenda grouped by day (Due now, Today, Tomorrow, weekdays).
- Not done (optional extras): dropping files onto Clawd. His window is click-through except over his pixels, so the OS doesn't deliver file drags to it; supporting it would mean a separate drop target window. Left out rather than half-working.
- CI for the inline-chat commit: green on Windows, macOS, and Linux; 41/41 smoke checks on both Windows and macOS.
- Tests: 157 unit tests; 42 smoke checks on Windows (44 with the live check).

## 2026-10-14: Inline terminal input, optional chat window, pixel-terminal bubble

- Clicking Clawd now opens a small terminal-style input right under his feet, inside his own window (so it moves with him). If he stands at the bottom of the screen, it appears just above his head instead. He stays put while it's open. Esc or clicking away with an empty input closes it.
- He answers in his speech bubble, restyled as a tiny pixel terminal: VT323 font, dark screen, mint text with a `>` prompt, stepped pixel border and tail, a typed-out reveal (off with reduced motion), scrolling for long replies, and a `[claude]` / `[offline · scripted]` tag.
- The CLAWD://TERMINAL window is optional: ▣ on the input, *Open chat window* in the right-click menu, or **Settings → Behavior → Chat style → Terminal window**. Commands typed inline answer in the bubble; "remember that…" requests open the window for the approval card.
- The companion window gained a 40 px input strip below Clawd (click-through while closed); default placement and re-layouts keep his feet where they were.
- Tests: 155 unit tests; 41 smoke checks on Windows (new: inline input opens under him and is focused, he stays put, the reply shows in the terminal bubble, Esc closes).

## 2026-10-14: Real Clawd, reliable drag and drop, terminal chat, features, macOS

### Clawd's artwork

- Researched sources: the reference article cites only the Claude Code repository; Anthropic publishes no redistributable sprite pack. Anthropic's **Claude desktop app** contains Clawd's original pixel animations (25 of them: Walking, Jumping, Thinking, Laptop, Waving, Dizzy, Meditating, …) in `clawdQuestEngine-*.js` inside `app.asar`.
- Added an importer (**Settings → Character & sprites → Import Clawd from the Claude app**) that reads that one file read-only from the user's own installation, decodes the animations, aligns all frames on the feet anchor, and writes a private pack to the user's data folder. No Clawd art is in the repository, the packages, or the screenshots. Frame mapping in ARTWORK.md.
- Verified on Windows with the installed Claude app (two versions: 2.31226 and 2.37337): 24 of 25 animations decode; all 15 Clawd Buddy states import with nothing skipped; the in-app path is covered by a smoke check.
- Bug found and fixed: inside Electron, `fs` treats `.asar` files as folders, so the in-app import couldn't see the Claude app's archive. The importer now uses Electron's `original-fs`.
- The stand-in "Pip" keeps working as the fallback (now with frames for the new states) and is never labeled; the "placeholder art" tag under the character is gone.

### Drag and drop

Root causes found in the previous implementation:

1. Window positions were computed from renderer `screenX/screenY`, derived from the renderer's cached window origin, which lags behind the real window during a drag (and isn't in DIP at mixed scaling). On release, the whole window, including its invisible bubble area and margins, was clamped into the work area (with a 48 px auto-hide taskbar margin), so drops near any edge, the top, or the bottom jumped.
2. After the first rewrite: a missed `pointerup` left a stale press that blocked every later press; losing pointer capture while the window moved was treated as a drop; the main process could stay "held" forever; and the window followed a 16 ms timer, capping it at about 60 updates per second.
3. The click-through hit test read sprite pixels from a canvas tainted by cross-origin images (`clawd-asset://`), so it threw on every mouse move and Clawd couldn't be grabbed at all.

Fixes: one position authority (`CompanionController`) with two movement paths that can't overlap (drag follower, walk ticker); the renderer reports only press, drag start, pointer moved, and release; the main process reads the OS cursor (`screen.getCursorScreenPoint()`, DIP) on every pointer event; the drop is applied once, exactly, and only Clawd's body is kept on a display (transparent margins may hang off the edge); release detection on the window plus `buttons === 0`, blur, Esc, and a watchdog; a new press always starts fresh; the sprite protocol allows CORS reads, and the hit test falls back to the body box if pixels are ever unreadable.

Verified with real mouse input on this Windows PC (synthesized at the OS level with `SendInput`, like a physical mouse):

- 6 consecutive drags across the screen: every drop landed exactly at the release point and didn't move during the 1.2 s landing.
- Performance on a 200 Hz display (`GetDeviceCaps VREFRESH`), pointer at 1200 px/s with ~800 input events/s: the window moved ~185 times per second (about once per display frame); pointer-to-window gap median 3 px (about 2.5 ms), 95th percentile 6 px, max 8 px; the window caught up within 1.5 ms after the pointer stopped. Same results while Clawd was animating.
- Not measured: 60/120 Hz displays, macOS, trackpads, a second monitor, or mixed DPI (only one 2560×1080 monitor here). Unit tests cover multi-monitor and negative coordinates; the manual checklist covers the rest. The visible frame rate also depends on the OS compositor; Electron doesn't guarantee one.

### Animation and motion

- State machine with explicit priorities: pickup/drag (100) > land (90) > think/talk > reactions > idle behaviors. While held or landing, only the drag protocol can change the state; reactions that arrive meanwhile (chat replies, errors) play after landing, and errors never show as happiness.
- Pickup: crouch and push-off frames; carried: arms-up loop; landing: impact squash, rebound, settle, all original frames, plus a light damped squash spring on the sprite (off with *Reduce motion*). The window never moves during the landing.
- Wandering: legs of 1–3 short walks with smooth acceleration and braking and pauses between legs; idle variations (look around, sway, turn), lightbulb, hula, waving, meditating nap.
- Crisp pixels: integer device pixels per art pixel at every scale factor.

### Chat and features

- Click Clawd to open **CLAWD://TERMINAL**: a frameless retro terminal next to him (VT323 font, SIL OFL, bundled with its license), with a status line (READY / THINKING... / TYPING... / OFFLINE / ERROR), `> YOU:` / `> CLAWD:` output, a block cursor, Enter to send, Esc to minimize, and its own minimize/close buttons.
- Jokes (setup, beat, punchline, happy reaction), fun facts (lightbulb), petting by rubbing the pointer over him (with a cooldown), tricks menu built from the pack's labeled animations, idle chatter off/quiet/chatty, animation intensity, reduce motion, read replies aloud (system voice), quick actions in the context menu.
- Reminders: `/remind 10m stretch`, `/remind at 15:30 standup`, Settings → Reminders; stored locally with one timer; due ones fire at startup if the app was closed.
- Chat history kept locally (last 100 lines), clearable, can be turned off.
- Chat commands: `/help /joke /fact /pet /trick /remind /reminders /done /forget /search /clear`.

### macOS and cross-platform

- OS differences isolated in `src/main/platform.ts`: menu bar template icon, app menu with Edit shortcuts, Dock hidden (`LSUIElement`), floating panel window across Spaces, Keychain via `safeStorage`, Claude Code lookup in Homebrew and `~/.local/bin`, Claude app at `/Applications/Claude.app`.
- Packaging: `npm run dist:mac` builds dmg and zip for arm64 and x64 (ad-hoc signed, not notarized); `npm run dist:win` builds the NSIS installer.
- Launchers `Launch-ClawdBuddy.bat` and `Launch-ClawdBuddy.command`; `.nvmrc`, `engines`, complete `.gitignore`, line-ending rules; `docs/DEVELOPMENT.md` and `docs/MACOS.md`.
- CI: check on Windows, macOS, Linux; smoke on Windows and macOS; packaging on Windows and macOS; actions updated to v7.
- Verified here (Windows): the `.bat` launcher runs from its folder and starts the app; the `.command` launcher passes `bash -n`.
- Verified on GitHub's macOS runner (CI run 38553891716): type-check, lint, unit tests, build, all 37 smoke checks (including drag and drop through the real window, hit testing, the chat terminal, reminders), and packaging of arm64 dmg/zip (ad-hoc signed; notarization skipped, no credentials).
- Found by the macOS smoke run and fixed: macOS kept the companion window's top edge below the menu bar, so drops near the top weren't exact. The window now uses `enableLargerThanScreen` on macOS so a frameless window goes exactly where the app places it.
- **Not run on a physical Mac** (no Mac available): real trackpad drags, the menu bar icon, Keychain prompts, notifications, the `.command` launcher by double-click, and Gatekeeper's first-launch flow still need a person with a Mac; see MANUAL_TESTING.md.

### Tests

- 155 unit tests (behavior priorities, repeated drags, rapid movement, lost releases, watchdog catch-up, multi-monitor and negative coordinates, landing never moving the window, walking easing, squash spring, layout crispness, reminders, chat history, settings migration, petting cooldown).
- 37 smoke checks, all passing on Windows (locally and in CI) and macOS (CI).

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
