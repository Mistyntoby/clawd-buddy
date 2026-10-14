import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "node:url";
import type { LinkKey } from "../shared/api";
import { isAllowed, isTrustedSenderUrl } from "../shared/ipc-policy";
import { validateSettingsPatch } from "../shared/settings-schema";
import {
  validateApiKeyFormat,
  validateBoolean,
  validateChatMessage,
  validateCommand,
  validateId,
  validateSection,
} from "../shared/validation";
import { toFriendlyError } from "./chat-errors";
import type { ClawdApp } from "./clawd-app";
import { testConnection } from "./claude-client";
import { checkClaudeCode } from "./claude-code-client";

const LINK_KEYS: readonly LinkKey[] = ["console", "claudeCode", "pricing", "docs", "privacy"];

/**
 * Registers every IPC handler. Each one checks that the sender is one of our
 * own windows, loaded from our own files, and allowed to use that channel —
 * then validates the payload before acting.
 */
export function registerIpc(app: ClawdApp, rendererDir: string): void {
  const rendererRoot = pathToFileURL(rendererDir).href;

  function authorized(channel: string, event: IpcMainEvent | IpcMainInvokeEvent): boolean {
    const role = app.windows.roleOf(event.sender);
    const url = event.senderFrame?.url;
    const ok = isAllowed(channel, role) && isTrustedSenderUrl(url, rendererRoot);
    if (!ok) console.warn(`[ipc] Rejected "${channel}" from an unauthorized sender.`);
    return ok;
  }

  function handle<T>(channel: string, fn: (payload: unknown) => T | Promise<T>): void {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      if (!authorized(channel, event)) throw new Error("Not allowed.");
      return fn(payload);
    });
  }

  function listen(channel: string, fn: (payload: unknown) => void): void {
    ipcMain.on(channel, (event, payload: unknown) => {
      if (!authorized(channel, event)) return;
      try {
        fn(payload);
      } catch {
        console.error(`[ipc] Handler for "${channel}" failed.`);
      }
    });
  }

  // ---- companion -------------------------------------------------------------
  handle("companion:ready", () => {
    const init = {
      pack: app.assets.info(),
      view: app.controller.view,
      config: app.companionConfig(),
      layout: app.windows.companionLayout,
    };
    setTimeout(() => app.companionReady(), 0);
    return init;
  });
  listen("companion:set-interactive", (p) => {
    const v = validateBoolean(p);
    if (v.ok && !app.controller.isHeld) app.windows.setCompanionInteractive(v.value);
  });
  // Drag protocol: the renderer only reports press / drag start / release.
  // Positions always come from the OS cursor in the main process (DIP), never from renderer coordinates.
  listen("companion:grab", () => {
    app.windows.setCompanionInteractive(true);
    app.controller.grab();
  });
  listen("companion:drag-start", () => {
    app.windows.setCompanionInteractive(true);
    app.controller.dragStart();
  });
  listen("companion:drag-move", () => app.controller.dragMove());
  listen("companion:release", () => {
    app.controller.release();
  });
  listen("companion:context-menu", () => app.showContextMenu());
  listen("companion:command", (p) => {
    const v = validateCommand(p);
    if (v.ok) app.runCommand(v.value);
  });
  listen("companion:dismiss-speech", () => app.controller.dismissSpeech());

  // ---- chat ------------------------------------------------------------------
  handle("chat:send", async (p) => {
    const v = validateChatMessage(p);
    if (!v.ok) return { ok: false, error: v.error };
    return app.sendChat(v.value);
  });
  handle("chat:cancel", () => app.chat.cancel());
  handle("chat:clear", () => {
    app.chat.clear();
  });
  handle("chat:status", () => {
    const s = app.settings.get();
    return { ...app.aiStatus(), name: s.companionName, memoryEnabled: s.memoryEnabled, readAloud: s.readAloud, reducedMotion: s.reducedMotion };
  });
  handle("chat:transcript", () => app.chat.transcript());
  listen("chat:window", (p) => {
    if (p === "minimize" || p === "close") app.windows.chatWindowControl(p);
  });

  // ---- settings ----------------------------------------------------------------
  handle("settings:get", () => app.settingsInit());
  handle("settings:set", (p) => {
    const v = validateSettingsPatch(p);
    if (!v.ok) return { ok: false, error: v.error };
    if (v.patch.launchAtStartup !== undefined && !app.capabilities().launchAtStartupSupported) {
      return { ok: false, error: app.capabilities().launchAtStartupReason ?? "Not supported." };
    }
    app.settings.update(v.patch);
    return { ok: true };
  });
  handle("settings:reset", () => {
    app.settings.reset();
  });

  // ---- AI configuration --------------------------------------------------------
  handle("ai:set-key", (p) => {
    const payload = (typeof p === "object" && p !== null ? p : {}) as { key?: unknown; persist?: unknown };
    const v = validateApiKeyFormat(payload.key);
    if (!v.ok) return { ok: false, error: v.error };
    const stored = app.secrets.setApiKey(v.value, payload.persist === true);
    app.notifyAiStatusChanged();
    return { ok: true, stored };
  });
  handle("ai:clear-key", () => {
    app.secrets.clearApiKey();
    app.notifyAiStatusChanged();
  });
  handle("ai:test", async () => {
    if (app.settings.get().aiProvider === "claude-code") {
      const cliPath = app.claudeCodePath(true);
      app.notifyAiStatusChanged();
      if (!cliPath) return { ok: false, error: "Claude Code wasn't found on this computer. Install it, then test again." };
      try {
        const auth = await checkClaudeCode(cliPath);
        if (!auth.loggedIn) {
          return { ok: false, error: "Claude Code is installed but not signed in. Run `claude` in a terminal and sign in with your Claude account." };
        }
        if (auth.authMethod !== "claude.ai") {
          return { ok: true, message: `Claude Code is ready, but it's signed in with "${auth.authMethod}", not a Claude subscription, so usage may be billed to that account.` };
        }
        const plan = auth.subscriptionType ? ` ${auth.subscriptionType.charAt(0).toUpperCase()}${auth.subscriptionType.slice(1)}` : "";
        return { ok: true, message: `Connected! Claude Code is signed in with your Claude${plan} subscription.` };
      } catch (err) {
        return { ok: false, error: toFriendlyError(err).message };
      }
    }
    const { key } = app.secrets.getApiKey();
    if (!key) return { ok: false, error: "No API key is configured." };
    try {
      await testConnection(key, app.settings.get().model);
      return { ok: true, message: `Connected! The model "${app.settings.get().model}" is available.` };
    } catch (err) {
      return { ok: false, error: toFriendlyError(err).message };
    }
  });

  // ---- memory --------------------------------------------------------------------
  handle("memory:list", () => app.memory.list());
  handle("memory:add", (p) => {
    const r = app.memory.add(p);
    if (r.ok) app.windows.sendSettings("settings:changed", app.settingsInit());
    return r.ok ? { ok: true } : r;
  });
  handle("memory:edit", (p) => {
    const payload = (typeof p === "object" && p !== null ? p : {}) as { id?: unknown; text?: unknown };
    const id = validateId(payload.id);
    if (!id.ok) return id;
    return app.memory.edit(id.value, payload.text);
  });
  handle("memory:remove", (p) => {
    const id = validateId(p);
    return id.ok ? app.memory.remove(id.value) : false;
  });
  handle("memory:clear", () => app.memory.clear());

  // ---- assets ----------------------------------------------------------------------
  // ---- reminders -----------------------------------------------------------------
  handle("reminders:list", () => app.reminders.list());
  handle("reminders:add", (p) => app.addReminder(typeof p === "string" ? p.slice(0, 400) : ""));
  handle("reminders:dismiss", (p) => typeof p === "string" && app.reminders.dismiss(p));
  handle("reminders:remove", (p) => typeof p === "string" && app.reminders.remove(p));

  handle("assets:info", () => ({ pack: app.assets.info(), packs: app.assets.listPacks() }));
  handle("assets:reload", () => app.reloadAssets());
  handle("assets:open-folder", () => app.openSpriteFolder());
  handle("assets:import-clawd", () => app.importClawdFromClaudeApp());

  // ---- app ---------------------------------------------------------------------------
  listen("app:open-settings", (p) => {
    const v = p === undefined || p === null ? null : validateSection(p);
    app.windows.openSettings(v && v.ok ? v.value : undefined);
  });
  listen("app:open-chat", () => app.openChat());
  listen("app:open-link", (p) => {
    if (LINK_KEYS.includes(p as LinkKey)) app.openLink(p as LinkKey);
  });
  listen("app:quit", () => app.quit());
}
