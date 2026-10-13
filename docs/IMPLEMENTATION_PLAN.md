# Implementation plan

## Goals

A Windows-first desktop companion in the spirit of classic desktop pets. It wanders, animates, talks in speech bubbles, and can optionally chat with Claude. It must be secure (hardened Electron, no key exposure), private (no monitoring, opt-in memory), and honest (offline replies are never attributed to Claude, and placeholder art is never passed off as Clawd).

## Key decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Shell | Electron + TypeScript (strict) | Transparent frameless windows, tray, and safeStorage; portable to macOS |
| Renderer | Vanilla TypeScript + a tiny DOM helper | Three small windows don't need a framework |
| Bundler | esbuild | One fast step for main, preload (sandbox needs a single CJS file), and renderers |
| Claude | Official `@anthropic-ai/sdk`, streaming, main process only | The key never reaches a renderer. Default model `claude-opus-5-5` lives in one constant. Low effort and short replies suit a companion. Server-side refusal fallback is enabled. |
| Key storage | Electron `safeStorage` (DPAPI) | OS-level encryption. Without it, the key is held in memory only and never written in plain text. |
| Persistence | JSON files in userData, written atomically | Small and dependency-free. A corrupt file falls back to defaults. |
| Artwork | Asset-provider system plus an original placeholder | No official, redistributable Clawd sprite source exists (see ARTWORK.md) |
| Tests | Vitest for pure logic, plus an in-app smoke mode (`CLAWD_SMOKE_DIR`) | Real-window checks without external GUI automation |

## Architecture

```
main process
  ClawdApp ─┬─ SettingsStore / MemoryStore / SecretStore   (userData JSON, safeStorage)
            ├─ AssetProvider ── clawd-asset:// protocol      (validated sprite packs)
            ├─ WindowManager ── companion / chat / settings windows (implements CompanionPort)
            ├─ CompanionController ── BehaviorMachine (pure state machine)
            │                       └─ movement math (pure)
            ├─ ChatService ── StreamFactory (Anthropic SDK) / OfflineBrain
            ├─ TrayController, context menu
            └─ registerIpc ── ipc-policy (per-window allow-list) + validators
preload   window.clawd — a fixed, typed API; no raw IPC
renderers companion (canvas sprite player, bubble, click-through hit testing)
          chat (streaming transcript, remember-approval cards)
          settings (welcome, behavior, AI, memory, sprites diagnostics, about)
```

### Behavior

There is a single source of truth: `BehaviorMachine` in the main process. States map 1:1 to animations. Events that aren't valid in the current state are ignored. Side effects use exactly one state timer, plus a walk interval only while walking, a speech timer, and an ambient timer. All are cleared on every state change and when paused.

### Click-through

The companion window ignores mouse events and forwards mouse moves. The renderer hit-tests the character and bubble rectangles and turns interaction on only while the pointer is over them.

## Phases

- [x] A: Inspect the environment, research asset licensing, write this plan
- [x] B: Secure windows, tray, sprite system, movement, placeholder
- [x] C: Context menu, speech bubbles, chat, settings, persistence
- [x] D: Claude streaming, cancellation, error mapping, thinking/talking transitions
- [x] E: Tests, smoke runs (dev and packaged), visual fixes, installer
- [x] F: Privacy audit, GitHub repository, push
