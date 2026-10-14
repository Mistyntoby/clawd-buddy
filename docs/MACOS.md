# Clawd Buddy on macOS

A step-by-step guide for getting Clawd onto your Mac. It works on Apple Silicon (M1/M2/M3/M4…) and Intel Macs running macOS 12 Monterey or newer.

There are two ways to run Clawd Buddy:

- **A. From the project folder (recommended).** You download the project once, then double-click a launcher whenever you want Clawd. This avoids all Gatekeeper warnings, because you aren't opening a downloaded app.
- **B. As a regular app** in your Applications folder. Either build it yourself on your Mac (no warnings), or download a build from GitHub (needs one extra approval, because the build isn't signed with a paid Apple developer certificate).

You'll type a few commands into **Terminal**. Open it with **⌘ Space**, type `Terminal`, and press Return. Copy each command, paste it into Terminal with **⌘ V**, and press Return.

---

## A. Run from the project folder

### 1. Install Node.js

Clawd Buddy needs Node.js 22 or newer.

1. Go to <https://nodejs.org/> and download the **LTS** version for macOS (the `.pkg` installer).
2. Open the downloaded file and click through the installer.
3. Check it in Terminal:

   ```bash
   node --version
   ```

   You should see `v22…` or higher. (If you already use `nvm`, `fnm`, Volta, or Homebrew for Node, that works too; the project has an `.nvmrc` file.)

### 2. Get the project

The easiest way is with Git, which macOS installs for you the first time you use it:

```bash
cd ~/Documents
git clone <repository URL>
cd clawd-buddy
```

Replace `<repository URL>` with the address from the repository's GitHub page (green **Code** button → copy). If macOS asks to install the "command line developer tools", click **Install**, wait for it to finish, and run the `git clone` line again.

(No Git? On the GitHub page choose **Code → Download ZIP**, double-click the ZIP in your Downloads folder, and move the `clawd-buddy` folder to Documents.)

### 3. Install the project's dependencies

Still in Terminal, inside the `clawd-buddy` folder:

```bash
npm ci
```

This downloads the exact package versions recorded in `package-lock.json` into the project folder (a few hundred MB, mostly Electron). Nothing is installed system-wide.

### 4. Start Clawd

```bash
npm start
```

Clawd appears near the bottom-right of your screen, and a small speech-bubble icon appears in the **menu bar** at the top right. Click that icon for Show/Hide, Chat, Settings, and Quit. (On a Mac, Clawd Buddy lives in the menu bar instead of the Dock.)

To stop him: menu bar icon → **Quit Clawd Buddy**, or press **Ctrl C** in the Terminal window.

### Run the launcher

Next time you don't need Terminal commands: double-click **`Launch-ClawdBuddy.command`** in the project folder. It finds its own folder, checks Node.js, offers to install dependencies if they're missing, and starts Clawd.

macOS needs your OK once before it runs a script you downloaded:

1. In Terminal, inside the project folder, make the launcher executable (only needed if you downloaded a ZIP instead of using `git clone`):

   ```bash
   chmod +x Launch-ClawdBuddy.command
   ```

2. In Finder, **right-click** (or Control-click) `Launch-ClawdBuddy.command` and choose **Open**.
3. macOS says it can't verify the developer. Click **Open**. On macOS 15 Sequoia and later, if there's no Open button: click **Done**, then go to **System Settings → Privacy & Security**, scroll down to the message about `Launch-ClawdBuddy.command`, and click **Open Anyway**.

After that, a normal double-click works. A Terminal window opens alongside Clawd; leave it open while he's running (closing it quits Clawd).

Tip: drag the launcher to the right side of your Dock (next to the Trash) for one-click access.

---

## B. Install as a regular app

### Option 1: build it yourself on your Mac (no warnings)

After steps 1–3 above:

```bash
npm run dist:mac
```

When it's done, open the `release` folder (`open release`). Use the `.dmg` matching your Mac:

- Apple Silicon: the file with `arm64` in its name.
- Intel: the one without (`x64`).

Not sure which you have? Apple menu → **About This Mac**: "Chip: Apple M…" means Apple Silicon; "Processor: Intel…" means Intel.

Double-click the `.dmg`, drag **Clawd Buddy** into **Applications**, and open it from Applications or Launchpad. The app is self-contained, so you can delete the project folder afterwards.

### Option 2: download a build from GitHub

Every change to the project is built automatically on a Mac by GitHub Actions.

1. On the repository's GitHub page, open **Actions**, click the latest successful **CI** run, and scroll down to **Artifacts**.
2. Download **clawd-buddy-macos** (you need to be signed in to GitHub) and unzip it.
3. Open the `.dmg` for your Mac (see above) and drag **Clawd Buddy** into **Applications**.

### Install a built app

These builds aren't signed with an Apple Developer ID or notarized by Apple (that needs a paid developer account), so macOS asks you to confirm the first time:

1. Open **Applications**, **right-click** Clawd Buddy, and choose **Open**, then **Open** again in the dialog.
2. On macOS 15 Sequoia and later, if the dialog only offers **Done** or **Move to Trash**: click **Done**, open **System Settings → Privacy & Security**, scroll to "Clawd Buddy was blocked…", click **Open Anyway**, and confirm with your password or Touch ID.

You only do this once. Please don't turn off Gatekeeper or other macOS security features to run Clawd Buddy; the steps above are Apple's supported way to open an app from outside the App Store. If you'd rather avoid this, build it yourself (Option 1); apps you build on your own Mac aren't quarantined.

---

## Make it Clawd

Out of the box you see a simple blue stand-in character, because Clawd's artwork belongs to Anthropic and isn't part of this project. To use the real Clawd:

1. Install the **Claude desktop app** from <https://claude.ai/download> (drag it to Applications).
2. In Clawd Buddy: menu bar icon → **Settings… → Character & sprites → Import Clawd from the Claude app**.

Clawd Buddy reads Clawd's original animations from your Claude app (read-only) and saves them in `~/Library/Application Support/Clawd Buddy/sprites/clawd`. They stay on your Mac and are never uploaded. If you moved Claude out of `/Applications`, move it back (or into `~/Applications`) so the importer can find it. Run the import again after the Claude app updates.

## Chat with Claude (optional)

Without setup, Clawd answers with simple offline replies. To chat with the real Claude, pick one:

- **Your Claude Pro or Max subscription:** install Claude Code (<https://docs.anthropic.com/en/docs/claude-code/setup>), run `claude` once in Terminal and sign in, then in Clawd Buddy go to **Settings → AI (Claude)**, set **Connect with** to *Claude subscription (Claude Code)*, turn on **Enable Claude**, and click **Test connection**.
- **An Anthropic API key** (billed per use): Settings → AI → paste the key → Save. With *Remember key* on, it's stored encrypted in your macOS Keychain. The first time, macOS may ask whether Clawd Buddy may use the Keychain; choose **Always Allow** (or **Allow** to be asked each time).

## Permissions on macOS

Clawd Buddy doesn't need any special macOS permissions: no Accessibility, Screen Recording, Input Monitoring, camera, or microphone. Dragging Clawd only uses the mouse position while you hold him. Reminder notifications appear only while Clawd is hidden; macOS may ask once whether to allow notifications from Clawd Buddy.

**Launch at startup** (Settings → Behavior) works in the installed app. You'll then see Clawd Buddy under **System Settings → General → Login Items**.

## Updating

From the project folder:

```bash
git pull
npm ci
```

Then start Clawd as usual. If you installed the app, rebuild it (`npm run dist:mac`) or download a newer build, and drag it into Applications again (replace the old one).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `node: command not found` | Install Node.js (step 1), then open a **new** Terminal window. |
| `npm ci` fails | Check your internet connection and run it again. Corporate networks can block the npm registry. |
| Clawd doesn't appear | Look for the speech-bubble icon in the menu bar; click it → Show. On MacBooks with a notch, menu bar icons can be hidden behind it; quit a few other menu bar apps or use a menu bar organizer. |
| "Launch-ClawdBuddy.command can't be opened" | Follow [Run the launcher](#run-the-launcher): `chmod +x`, then right-click → Open (or **Open Anyway** in Privacy & Security). |
| "Clawd Buddy is damaged and can't be opened" | This happens to downloaded apps that aren't signed by a registered developer. Build the app yourself instead (Option 1), or run it from the project folder (A). |
| The import says the Claude app wasn't found | Install it from claude.ai/download and keep it in Applications. |
| Text in the chat looks blurry | It shouldn't: the terminal font is bundled. Make sure you're on the latest version (`git pull`). |

## What has and hasn't been tested on a Mac

The Mac code paths (menu bar icon, app menu with copy/paste shortcuts, floating panel window across Spaces, Retina-sharp sprites, Keychain storage, Claude Code lookup in `~/.local/bin` and Homebrew, the Claude app importer at `/Applications/Claude.app`) are built and checked automatically on GitHub's macOS machines: type-check, unit tests, the in-app smoke test, and the `.dmg`/`.zip` packaging. The project's author developed on Windows and **hasn't run it on a physical Mac yet**. If something looks off, please open an issue with your macOS version and Mac model.
