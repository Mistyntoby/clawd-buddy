# Manual test procedure

Automated coverage: `npm test` (91 unit tests) and `npm run smoke` (21 runtime checks against the real app: windows, sprite loading, IPC policy, first-run flow, settings validation, walking, offline chat labeling, broken sprite packs, hide/show, on-screen placement).

The items below involve native OS UI (context menus, the tray, real mouse drags) that the smoke test doesn't drive. Run them before a release.

## Setup

Start from a clean profile: quit the app and rename `%APPDATA%\Clawd Buddy` (or use a fresh Windows user). Then run `npm start` or the installed app.

## Checklist

1. **First run.** The companion appears bottom-right with a welcome bubble, and Settings opens on *Welcome*.
2. **Transparency and click-through.** Clicking empty space next to the character reaches the window underneath. The character itself is clickable.
3. **Single-click.** The character does a happy hop with a pop sound (if sounds are on).
4. **Double-click.** The chat window opens next to the companion.
5. **Right-click.** A native menu appears with Talk to Clawd, Open chat, Tell me something, What can you help with?, Wander around ✓, Movement speed ▸, Sounds ✓, Settings…, Hide, and Quit. Try each item:
   - *Tell me something* shows a fun fact (offline) or a Claude reply (online).
   - *What can you help with?* shows the help bubble.
   - Unchecking *Wander around* stops all walking.
   - The *Movement speed* radio items change walking speed.
6. **Drag.** Drag the character across the screen and onto a second monitor. Release it partly off-screen and confirm it snaps fully onto the display. Quit and relaunch: it reappears in the same spot.
7. **Tray.** Left-click toggles show/hide, and the first hide shows a one-time hint. The right-click menu items all work.
8. **Single instance.** Launching the app a second time doesn't create a second companion, and a hidden companion reappears.
9. **Displays.** Change the display resolution or scaling, or unplug a monitor. The companion stays fully visible.
10. **Auto-hide taskbar.** With the taskbar on auto-hide, the companion sits above where the taskbar pops up.
11. **Offline chat.** With no key set, replies are labeled "Offline mode · scripted reply, not from Claude", and a banner explains offline mode.
12. **Claude chat** (needs a valid key; usage is billed):
    - Settings → AI: save the key and run *Test connection*, which should report the model as available.
    - In chat, Clawd shows *think*, then *talk* while text streams into the chat and the bubble, then idle.
    - Click *Stop* mid-reply: the reply stops, "Stopped." appears, and Clawd returns to idle.
    - Use an invalid key: you get a friendly "key was rejected" message and Clawd looks confused.
    - Disconnect the network: you get the friendly network message.
13. **Memory.** Type "remember that I like tea". A Save / Don't-save card appears (or a notice if memory is off). Saved items appear in Settings → Memory and can be edited and deleted.
14. **Settings persistence.** Change speed, size, sounds, and always-on-top, then restart. All changes are kept. *Reset all settings* restores the defaults.
15. **Launch at startup.** In the installed app the toggle is enabled and adds a login item; when running from source it's disabled with an explanation.
16. **Sprites.** Settings → Character → *Open sprite folder*. Add a folder with a broken `manifest.json` and click *Reload*: the error is listed and the app keeps running. Add a valid pack containing only `idle`: it's used, and the other animations show "fallback".
