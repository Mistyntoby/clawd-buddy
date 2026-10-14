# Manual test procedure

Automated coverage: `npm test` (unit tests) and `npm run smoke` (runtime checks against the real app on a throw-away profile: windows, transparency and hit-testing, drag and drop through the real window including repeated drags and a lost release, landing without movement, the chat terminal and its commands, reminders, offline labeling, the Clawd import, security boundaries, broken sprite packs, hide/show). CI runs both on Windows and macOS.

The items below need a person, a real mouse or trackpad, and native OS UI (menus, tray/menu bar, notifications). Run them on **both Windows and macOS** before a release.

## Setup

Start from a clean profile: quit the app and rename the data folder (Windows `%APPDATA%\Clawd Buddy`, macOS `~/Library/Application Support/Clawd Buddy`). Then use the launcher, `npm start`, or the packaged app.

## Checklist

1. **First run.** The companion appears bottom-right with a welcome bubble and waves; Settings opens on *Welcome* with the right instructions for the OS.
2. **Clawd import.** Settings → Character & sprites → *Import Clawd from the Claude app* (with the Claude desktop app installed). The stand-in turns into Clawd immediately; the pack shows "from your Claude app". Without the Claude app, a clear "wasn't found" message.
3. **No label.** Nothing is drawn under or around the character except speech bubbles.
4. **Click-through.** Clicking the empty space next to Clawd reaches the window underneath; only his visible pixels are clickable.
5. **Click.** A small terminal input appears right under him, focused (above his head if he stands on the taskbar). Type, Enter: he answers in the pixel-terminal bubble (typed out; long replies scroll). He doesn't wander while it's open. Esc or clicking elsewhere with an empty input closes it; clicking him again toggles it. The ▣ button opens the chat window. With *Chat style: Terminal window*, a click opens the window instead.
6. **Petting.** Rub the pointer quickly back and forth over him (without pressing): a happy reaction and a short bubble; rubbing on and on doesn't spam reactions (cooldown).
7. **Drag and drop** (mouse, then trackpad):
   - Press and move: a short crouch, then the arms-up carried pose; he follows the pointer smoothly without lag or stutter, also when moving fast and on a high-refresh display.
   - Release: he lands exactly where you let go: impact squash, a small hop, one or two lower bounces, rest. The window never shifts during or after the landing; with Reduce motion there's no hop.
   - Repeat 10+ times without restarting, while idle, walking, talking, and thinking (send a chat message, then drag during the reply).
   - Fling quickly and release outside his old position: no stuck drag, no jump.
   - Release over another window, Alt-Tab / Cmd-Tab mid-drag, press Esc mid-drag: the drag always ends cleanly where he is.
   - A click without movement still opens the chat (no accidental drag); a drag never also opens the chat.
   - Drop partly off a screen edge: only nudged far enough to keep his body visible.
   - Second monitor (including one left of or above the main one, and one with different scaling): drag across, drop, quit, relaunch; he reappears at the same spot.
8. **Wandering.** He walks in short, deliberate trips (smooth start and stop, pauses between legs) and never while held. Unchecking *Wander around* stops all autonomous movement.
9. **Chat window (optional).** Right-click → *Open chat window*. Enter sends, Shift+Enter adds a line, Esc minimizes (or stops a reply), `_` minimizes, `X` closes (Clawd stays); dragging the title bar moves the terminal. The status shows READY/OFFLINE, THINKING..., TYPING..., ERROR. Text is sharp at 100%, 125%, 150% scaling and on Retina.
10. **Commands.** `/help`, `/joke` (setup, pause, punchline, happy reaction), `/fact` (lightbulb), `/pet`, `/trick` and `/trick hula`, `/remind 1m test`, `/reminders`, `/done 1`, `/forget 1`, `/search crabs` (opens the browser only then), `/clear`.
11. **To-dos.** `/todo buy milk`, `/todo`, `/todo done 1` (a happy reaction), `/todo clear`; the same list in Settings → Reminders & to-dos with checkboxes. Survives a restart.
12. **Reminders.** Add one for 1 minute in Settings → Reminders: when due, Clawd shows a bubble and waves (or, if hidden, a system notification). Mark it *Done*, delete another. Quit with a pending reminder, relaunch after it was due: it fires at startup.
13. **Context menu.** Chat, Tell a joke, Fun fact, Pet, Do a trick ▸, Reminders…, Wander, Movement speed ▸, Sounds, Settings…, Hide, Quit all work.
14. **Tray / menu bar.** Windows: left-click toggles show/hide; right-click shows the menu. macOS: clicking the menu bar icon opens the menu. Copy/paste work in the chat on macOS (⌘C/⌘V).
15. **Idle chatter.** Off: no unprompted remarks. Quiet: rare and silent. Chatty: every 6–15 minutes with a sound.
16. **Animation intensity and reduced motion.** Calm/Lively visibly change how often he does things. *Reduce motion* (or the OS setting) removes squash, bounce, and the terminal's typing effect.
17. **Chat history.** Chat, quit, relaunch: the recent conversation is still there. *Keep chat history* off deletes it; `/clear` and *Clear chat history* empty it.
18. **Read replies aloud.** On: replies are spoken with the system voice.
19. **Claude chat** (needs Claude Code signed in, or an API key):
    - *Test connection* reports your plan or model.
    - In chat, Clawd thinks, then types on his laptop while text streams in, then idles.
    - *STOP* mid-reply stops it; an invalid key, no network, or a usage limit give friendly messages and a confused reaction (never a happy one).
20. **Single instance.** Launching again doesn't create a second Clawd; a hidden Clawd reappears.
21. **Launch at startup.** Packaged app only: the toggle adds a login item (Windows startup apps / macOS Login Items).
22. **Launchers.** Double-click `Launch-ClawdBuddy.bat` (Windows) and `Launch-ClawdBuddy.command` (macOS, after the one-time permission in docs/MACOS.md). With `node_modules` deleted, each asks before running `npm ci`.
