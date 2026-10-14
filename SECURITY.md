# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting instead: the **Security** tab → **Report a vulnerability**. Include the steps to reproduce and the impact. I'll respond as soon as I can.

## Scope

Areas of particular interest:

- Ways for renderer content (chat output, sprite files, manifests) to reach Node, the filesystem, or IPC channels outside its window's allow-list
- Leaks of the API key, whether to a renderer, logs, or disk in plain text
- Path traversal through sprite packs or the `clawd-asset://` protocol
- The Clawd importer reading anything beyond the one sprite asset in the user's own Claude app
- Any way that conversation text could trigger actions on the computer

## Design summary

- Context isolation, sandboxed renderers, `nodeIntegration: false`, and a strict CSP in every window.
- A narrow typed preload API. The main process checks each IPC message against the sender window's role and its bundled file URL, then validates the payload.
- The API key stays in the main process and is encrypted at rest with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS). If encryption is unavailable, it is never written to disk.
- With the Claude subscription option, the app starts the user's own Claude Code executable directly (no shell), with the prompt on stdin, all tools disabled, `--safe-mode`, no session persistence, and an empty working folder. It never reads Claude Code's credentials.
- Sprite files are served only from validated pack folders, via a custom protocol that rejects traversal and non-image files. Responses allow CORS reads (`Access-Control-Allow-Origin: *`) so the companion can read sprite pixels for click-through hit testing; they are plain images and the protocol is only reachable from the app's own windows.
- The Clawd importer runs only when the user clicks it. It reads one file inside the installed Claude app read-only, parses it as data without executing it (size-limited, validated), and writes PNGs and a manifest into the user's own data folder.
- Reminders, chat history, and settings are local JSON files written atomically; on load they are validated and anything malformed is dropped.
- Chat commands never run programs: `/search` only opens a DuckDuckGo URL in the default browser, and only when the user types it.
- Navigation and new windows are blocked; only `https://` links open, and they open in the system browser. All permission requests are denied.

## Supported versions

Only the latest release receives fixes.
