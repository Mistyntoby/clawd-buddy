import { app, type BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ClawdApp } from "./clawd-app";

/**
 * Automated runtime check, enabled with CLAWD_SMOKE_DIR. Launches the real app
 * against an isolated profile, exercises the windows, writes screenshots and a
 * results.json into that directory, then exits with a non-zero code on failure.
 */

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep polling */
    }
    await wait(100);
  }
  return false;
}

async function capture(win: BrowserWindow, file: string): Promise<number> {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
  return image.getSize().width;
}

export async function runSmokeTest(clawd: ClawdApp, dir: string): Promise<void> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  fs.mkdirSync(dir, { recursive: true });

  try {
    const companion = clawd.windows.companion;
    check("companion window created", !!companion);
    if (!companion) throw new Error("no companion");

    const loaded = await waitFor(() => !companion.webContents.isLoading(), 10_000);
    check("companion page loaded", loaded);
    const visible = await waitFor(() => companion.isVisible(), 5_000);
    check("companion window visible", visible);
    const b = companion.getBounds();
    const inside = clawd.windows
      .workAreas()
      .some((a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
    check("companion fully inside the usable desktop area", inside, JSON.stringify(b));

    const js = (win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code, true);

    const spriteReady = await waitFor(async () => (await js(companion, "document.body.dataset.spriteReady")) === "true", 8_000);
    check("sprite frames loaded in renderer", spriteReady, String(await js(companion, "document.body.dataset.spriteStatus")));
    check("placeholder label shown", (await js(companion, "!!document.querySelector('#placeholder-tag:not([hidden])')")) === true);

    // Security: no Node in the renderer, and IPC policy rejects out-of-role calls.
    check("renderer has no require/process", (await js(companion, "typeof require === 'undefined' && typeof process === 'undefined'")) === true);
    const forbidden = await js(companion, "window.clawd.settings.get().then(() => 'allowed', () => 'rejected')");
    check("companion cannot read settings via IPC", forbidden === "rejected", String(forbidden));

    // Welcome bubble on first run.
    const bubble = await waitFor(async () => (await js(companion, "document.querySelector('#bubble')?.hidden === false")) === true, 5_000);
    check("welcome speech bubble shown", bubble);
    const fits = await js(companion, "(() => { const r = document.querySelector('#bubble').getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.right <= innerWidth; })()");
    check("speech bubble fits inside the window", fits === true);
    await wait(300);
    await capture(companion, path.join(dir, "companion.png"));

    // Welcome opens settings on first run.
    const settingsOpened = await waitFor(() => !!clawd.windows.settings && !clawd.windows.settings.webContents.isLoading(), 8_000);
    check("settings window opens on first run", settingsOpened);
    if (clawd.windows.settings) {
      const s = clawd.windows.settings;
      await waitFor(async () => (await js(s, "document.body.dataset.ready")) === "true", 5_000);
      check("settings shows welcome section", (await js(s, "document.querySelector('[data-section=welcome]:not([hidden])') !== null")) === true);
      await capture(s, path.join(dir, "settings.png"));
      // Toggle a setting through the real UI path and confirm persistence.
      await js(s, "window.clawd.settings.set({ movementSpeed: 'fast' })");
      check("setting change applied", clawd.settings.get().movementSpeed === "fast");
      const bad = await js(s, "window.clawd.settings.set({ characterScale: 99 })");
      check("invalid setting rejected", (bad as { ok: boolean }).ok === false);
      // Subscription provider: selectable, rendered, and still offline while AI is disabled.
      await js(s, "window.clawd.settings.set({ aiProvider: 'claude-code' })");
      clawd.windows.sendSettings("settings:navigate", "ai");
      const providerShown = await waitFor(
        async () => (await js(s, "document.querySelector('select[aria-label=aiProvider]')?.value")) === "claude-code",
        3_000,
      );
      check("Claude subscription provider selectable", providerShown && clawd.aiConnection() === null);
      await js(s, "window.clawd.settings.set({ aiProvider: 'api' })");
    }

    // Movement: force a wander and confirm the window moves within the screen.
    clawd.controller.dismissSpeech();
    const before = clawd.windows.getPosition();
    clawd.controller.machine.send("RESET");
    const wandered = clawd.controller.machine.send("WANDER_START");
    await wait(1500);
    const after = clawd.windows.getPosition();
    check("companion walks", wandered && (before.x !== after.x || clawd.controller.state === "idle"), `${before.x} -> ${after.x}`);
    clawd.controller.machine.send("ARRIVED");

    // Chat (offline mode, no API key in the smoke profile).
    clawd.openChat();
    const chat = clawd.windows.chat;
    check("chat window opens", !!chat);
    if (chat) {
      await waitFor(() => !chat.webContents.isLoading(), 8_000);
      await waitFor(async () => (await js(chat, "document.body.dataset.ready")) === "true", 5_000);
      await js(
        chat,
        "(() => { const i = document.querySelector('#input'); i.value = 'hello there'; document.querySelector('#composer').requestSubmit(); })()",
      );
      const replied = await waitFor(async () => (await js(chat, "document.querySelectorAll('.msg.assistant').length")) >= 1, 5_000);
      check("offline chat reply rendered", replied);
      const label = await js(chat, "document.querySelector('.msg.assistant .msg-source')?.textContent ?? ''");
      check("offline reply labeled as offline (not Claude)", /offline/i.test(String(label)) && String(label).trim() !== "Claude", String(label));
      await wait(400); // let the message fade-in finish
      await capture(chat, path.join(dir, "chat.png"));
    }

    // Missing assets: a broken user pack must not crash anything.
    const brokenDir = path.join(clawd.assets.userDir, "broken-pack");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "manifest.json"), "{ not json");
    const reloaded = clawd.reloadAssets();
    const broken = reloaded.packs.find((p) => p.id === "broken-pack");
    check("broken sprite pack reported, not fatal", !!broken && !broken.valid && reloaded.pack.id === "placeholder");

    // Hide / show cycle.
    clawd.hideCompanion();
    check("hide works", !clawd.windows.isVisible());
    clawd.showCompanion();
    check("show works", await waitFor(() => clawd.windows.isVisible(), 2000));
  } catch (err) {
    check("smoke test ran to completion", false, err instanceof Error ? err.message : String(err));
  }

  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify({ passed: failed.length === 0, checks }, null, 2));
  for (const c of checks) console.info(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  clawd.shutdown();
  app.exit(failed.length === 0 ? 0 : 1);
}
