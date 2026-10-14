# Developing Clawd Buddy

How to set up the project on Windows or macOS, move between computers through GitHub, and build releases.

Everything needed to build and run lives in Git: source, tests, scripts, configuration, the stand-in artwork, and the bundled font. Things that are personal or machine-specific are **not** in Git and never should be: `node_modules/`, build output (`dist/`, `release/`), API keys, your settings, and any Clawd artwork imported from your Claude app (see `.gitignore`).

## Requirements

| | Version | Notes |
| --- | --- | --- |
| Node.js | 24 (see `.nvmrc`); 22+ works | `node --version` |
| npm | 11 (bundled with Node 24) | The lockfile `package-lock.json` pins every dependency |
| Git | any recent | |
| OS | Windows 10/11, macOS 12+ | Linux runs the tests and builds in CI but isn't a supported desktop target |

With a version manager, run `nvm use` (nvm, macOS) or `fnm use` (fnm, either OS) in the project folder to pick the version from `.nvmrc`. Without one, install Node from <https://nodejs.org/>.

## Commands

The same commands work in **PowerShell** (Windows) and **Terminal** (macOS):

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies exactly as recorded in `package-lock.json` |
| `npm start` | Build and launch the app (what the launchers run) |
| `npm run check` | Type-check, lint, unit tests, build. Run this before committing |
| `npm test` | Unit tests only |
| `npm run smoke` | Launch the real app against a throw-away profile and run the runtime checks; screenshots in `smoke-output/` |
| `npm run dist` | Package for the OS you're on |
| `npm run dist:win` | Windows NSIS installer (run on Windows) |
| `npm run dist:mac` | macOS `.dmg` + `.zip` for arm64 and x64 (run on a Mac) |
| `npm run dist:dir` | Unpacked app folder, faster for testing packaging |

Use `npm install <package>` only when you deliberately add or upgrade a dependency, and commit the updated `package-lock.json` with it.

### Launchers

`Launch-ClawdBuddy.bat` (Windows) and `Launch-ClawdBuddy.command` (macOS) in the project root are thin wrappers around `npm start`. They resolve the project folder from their own location, check the Node.js version, offer `npm ci` if dependencies are missing, repair a skipped Electron download, and keep the window open on errors. All startup logic stays in `package.json`.

## Moving between computers

### On the computer you're leaving

Windows (PowerShell) and macOS (Terminal) are the same here:

```
git status
npm run check
git add -A
git commit -m "Describe what you changed"
git push
```

`git status` shows what changed; make sure nothing unexpected (logs, keys, artwork) is listed. `npm run check` must pass before you push. If you ran the app, `npm run smoke` is a good extra check.

### On the other computer

First time:

```
git clone <repository URL>
cd clawd-buddy
npm ci
npm start
```

Afterwards:

```
git pull
npm ci
npm start
```

Run `npm ci` after every pull: it is quick when nothing changed, and it keeps `node_modules` exactly in sync with the lockfile (dependencies are platform-specific, so never copy `node_modules` between computers).

### Local setup that doesn't travel through Git

Each computer has its own, outside the project folder:

| What | Where | How to set it up |
| --- | --- | --- |
| Settings, memory, reminders, chat history | Windows `%APPDATA%\Clawd Buddy\`, macOS `~/Library/Application Support/Clawd Buddy/` | Created on first run |
| API key | Encrypted in the same folder (DPAPI / Keychain) | Settings → AI, per computer. Never put a key in the repository or a committed file |
| `ANTHROPIC_API_KEY` (optional) | Environment variable | Windows: `setx ANTHROPIC_API_KEY "sk-ant-…"` then open a new terminal. macOS: add `export ANTHROPIC_API_KEY="sk-ant-…"` to `~/.zshrc`. Only if you prefer it to the Settings page |
| Claude subscription | Claude Code's own sign-in | Install Claude Code and run `claude` once on each computer |
| Clawd artwork | `<app data folder>/sprites/clawd/` | Install the Claude desktop app, then Settings → Character & sprites → Import Clawd. Repeat on each computer |
| Other sprite packs | `<app data folder>/sprites/<name>/` or `assets/sprites/local/<name>/` (git-ignored) | Copy them yourself |

## Architecture in brief

```
src/main/       Electron main process
  clawd-app.ts          wires everything together
  companion-controller  behavior + the single authority over the companion window's position
  platform.ts           everything that differs between Windows and macOS
  window-manager.ts     the three windows; implements the controller's CompanionPort
  chat-service.ts       conversation, streaming, persistence; claude-client.ts (API), claude-code-client.ts (subscription)
  reminders.ts          reminder store with one timer
  clawd-desktop-sprites.ts, clawd-import.ts   reading Clawd from the user's Claude app
src/preload/    the narrow window.clawd bridge
src/renderer/   companion (sprite, hit-testing, squash), chat (terminal), settings
src/shared/     pure logic with unit tests: behavior state machine, layout, movement, reminders, manifest, IPC policy
```

Platform differences are confined to `src/main/platform.ts` (window level and type, tray icon and click behavior, app menu and Dock, login items, where to find Claude Code and the Claude app). Everything else is shared.

### Motion rules (don't break these)

- Only `CompanionController` calls `setPosition` on the companion window, from exactly two places: the drag follower and the walk ticker. Anything else that wants Clawd somewhere must go through the controller.
- The renderer never computes window positions. It reports press / drag start / pointer moved / release; the main process reads the OS cursor.
- Visual effects (squash, bounce, landing) happen inside the renderer and never move the window.
- Timing and motion tuning lives in `MOTION` in `src/shared/constants.ts`.

## Testing

- **Unit tests** (`tests/`) cover the state machine and priorities, drag/drop (repeated drags, lost releases, rapid movement, multi-monitor and negative coordinates, display changes mid-drag, landing never moving the window), walking easing, layout crispness, squash spring, reminders, chat persistence, the Claude Code client, settings validation, and the sprite manifest.
- **Smoke test** (`npm run smoke`) drives the real app: windows, transparency and hit-testing, drag and drop through the real window, the chat terminal and its commands, offline labeling, security boundaries, broken sprite packs. It runs on Windows and macOS in CI.
- **Manual checks** that need a person and a real mouse are listed in [MANUAL_TESTING.md](MANUAL_TESTING.md).

## Releases

CI (`.github/workflows/ci.yml`) runs on every push to `main` and on pull requests:

1. Type-check, lint, unit tests, build on Windows, macOS, and Linux.
2. Smoke test on Windows and macOS.
3. Packaging on Windows (NSIS installer) and macOS (dmg + zip, arm64 + x64). Download the results from the run's **Artifacts**.

Nothing is published automatically. Signing: no certificates are configured and none belong in this repository. Windows builds are unsigned; macOS builds are ad-hoc signed (`"identity": "-"`), not Developer ID signed and not notarized. To sign properly later, provide certificates through CI secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, and for notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and remove the ad-hoc identity. Build each OS's package on that OS (or its CI runner).

## Privacy checklist before pushing

- `git status` / `git diff --cached`: no keys, `.env` files, logs, personal paths, or artwork.
- Screenshots for docs come from `npm run smoke` (clean profile, stand-in character), never from your real desktop.
- Commit author: this repository uses a neutral project identity configured in its local Git config (`git config user.name` / `user.email` inside the folder). On a new computer, set it the same way, locally:

  ```
  git config user.name "Clawd Buddy"
  git config user.email "maintainers@clawd-buddy.invalid"
  ```
