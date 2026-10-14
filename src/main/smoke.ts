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
    const body = clawd.windows.bodyRect();
    const inside = clawd.windows
      .workAreas()
      .some((a) => b.x + body.x >= a.x && b.y + body.y >= a.y && b.x + body.x + body.width <= a.x + a.width && b.y + body.y + body.height <= a.y + a.height);
    check("character fully inside the usable desktop area", inside, JSON.stringify(b));

    const js = (win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code, true);

    const spriteReady = await waitFor(async () => (await js(companion, "document.body.dataset.spriteReady")) === "true", 8_000);
    check("sprite frames loaded in renderer", spriteReady, String(await js(companion, "document.body.dataset.spriteStatus")));
    // Nothing but the character (and, when speaking, the bubble) is drawn: no label, caption, or name under Clawd.
    const stray = await js(
      companion,
      "[...document.body.querySelectorAll('*')].filter((el) => !el.closest('#bubble') && el.getClientRects().length > 0 && el.children.length === 0 && (el.textContent ?? '').trim() !== '').map((el) => el.id || el.tagName)",
    );
    check("no label or text around the character", Array.isArray(stray) && stray.length === 0, JSON.stringify(stray));
    const crisp = await js(
      companion,
      "(() => { const c = document.querySelector('#sprite'); const s = getComputedStyle(c); return { w: c.width, cssW: c.getBoundingClientRect().width, dpr: devicePixelRatio, ir: s.imageRendering }; })()",
    );
    const lay = clawd.windows.companionLayout;
    check(
      "sprite canvas is pixel-exact (integer device pixels per art pixel, no smoothing)",
      Number.isInteger(lay.devicePixelsPerArtPixel) && crisp.w === clawd.assets.info().frameWidth * lay.devicePixelsPerArtPixel && /pixelated|crisp-edges/.test(String(crisp.ir)),
      JSON.stringify({ ...crisp, devicePx: lay.devicePixelsPerArtPixel }),
    );

    // Hover: the window must become clickable over Clawd's pixels and stay click-through elsewhere.
    {
      const hover = (x: number, y: number) =>
        js(companion, `window.dispatchEvent(new MouseEvent("mousemove", { clientX: ${x}, clientY: ${y}, bubbles: true }))`);
      const errors: string[] = [];
      const onConsole = (_e: unknown, level: number, message: string) => {
        if (level >= 3) errors.push(message);
      };
      companion.webContents.on("console-message", onConsole);
      await hover(body.x + body.width / 2, body.y + body.height / 2);
      const onBody = await waitFor(() => clawd.windows.companionInteractive, 2_000);
      await hover(4, 4);
      const offBody = await waitFor(() => !clawd.windows.companionInteractive, 2_000);
      companion.webContents.off("console-message", onConsole);
      check("hovering Clawd makes him clickable; empty space stays click-through", onBody && offBody && errors.length === 0, errors.join(" | ").slice(0, 200));
      const readable = await js(
        companion,
        "(() => { try { document.querySelector('#sprite').getContext('2d').getImageData(0, 0, 1, 1); return 'ok'; } catch (e) { return String(e && e.name); } })()",
      );
      check("sprite pixels are readable for pixel-exact hit testing", readable === "ok", String(readable));
    }

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

    // Drag and drop through the real window: positions come from the (here simulated) OS cursor.
    {
      const port = clawd.windows as unknown as { cursorPoint: () => { x: number; y: number } };
      const realCursor = port.cursorPoint.bind(clawd.windows);
      const start = clawd.windows.getPosition();
      const area = clawd.windows.workAreas()[0]!;
      let cursor = { x: start.x + body.x + 10, y: start.y + body.y + 10 };
      port.cursorPoint = () => ({ ...cursor });
      clawd.controller.machine.send("RESET");
      clawd.controller.machine.send("WANDER_START"); // grab while walking
      await wait(200);
      // The press happens on Clawd wherever he is right now.
      const pressAt = clawd.windows.getPosition();
      cursor = { x: pressAt.x + body.x + 10, y: pressAt.y + body.y + 10 };
      clawd.controller.grab();
      const stoppedAt = clawd.windows.getPosition();
      await wait(300);
      check("grabbing stops wandering immediately", clawd.controller.state === "idle" && clawd.windows.getPosition().x === stoppedAt.x);
      clawd.controller.dragStart();
      const target = { x: area.x + Math.round(area.width * 0.3), y: area.y + Math.round(area.height * 0.4) };
      for (let i = 1; i <= 10; i++) {
        cursor = { x: cursor.x + (target.x - cursor.x) / (11 - i), y: cursor.y + (target.y - cursor.y) / (11 - i) };
        clawd.controller.dragMove(); // what each renderer pointer event triggers
        await wait(16);
      }
      const followed = clawd.windows.getPosition();
      check(
        "window follows each pointer event immediately (no catch-up lag)",
        followed.x === Math.round(cursor.x - body.x - 10) && followed.y === Math.round(cursor.y - body.y - 10),
        JSON.stringify(followed),
      );
      const statesSeen = clawd.controller.state;
      clawd.controller.release();
      const expected = { x: Math.round(target.x - body.x - 10), y: Math.round(target.y - body.y - 10) };
      const dropped = clawd.windows.getPosition();
      check("window stays exactly at the drop position", dropped.x === expected.x && dropped.y === expected.y, `${JSON.stringify(dropped)} vs ${JSON.stringify(expected)}`);
      check("carried pose while held, landing after release", ["pickup", "drag"].includes(statesSeen) && clawd.controller.state === "land", `${statesSeen} -> ${clawd.controller.state}`);
      // The drop bounce is a transform on the sprite: it moves Clawd up and back down inside the window.
      let minY = 0;
      for (let i = 0; i < 12; i++) {
        await wait(25);
        const tf = String(await js(companion, "document.querySelector('#character').style.transform"));
        const m = /translateY\((-?[\d.]+)px\)/.exec(tf);
        if (m) minY = Math.min(minY, Number(m[1]));
      }
      const midBounce = clawd.windows.getPosition();
      check("drop plays a bounce (transform) without moving the window", minY < -6 && midBounce.x === expected.x && midBounce.y === expected.y, `hop ${minY.toFixed(1)} px`);
      await wait(900);
      const settled = clawd.windows.getPosition();
      check("landing doesn't move the window", settled.x === expected.x && settled.y === expected.y && clawd.controller.state !== "land", JSON.stringify(settled));
      check("drop position is saved", JSON.stringify(clawd.settings.get().position) === JSON.stringify(expected));

      // Five more drags in a row, including one whose release is never reported.
      let ok = true;
      const misses: string[] = [];
      for (let n = 0; n < 5; n++) {
        const from = clawd.windows.getPosition();
        cursor = { x: from.x + body.x + 12, y: from.y + body.y + 12 };
        clawd.controller.grab();
        clawd.controller.dragStart();
        const to = { x: area.x + 200 + n * 150, y: area.y + 150 + n * 90 };
        cursor = { x: to.x, y: to.y };
        clawd.controller.dragMove();
        if (n === 3) continue; // lost release: the next grab must still work
        clawd.controller.release();
        const at = clawd.windows.getPosition();
        const want = { x: to.x - body.x - 12, y: to.y - body.y - 12 };
        if (at.x !== want.x || at.y !== want.y) {
          ok = false;
          misses.push(`${JSON.stringify(at)}≠${JSON.stringify(want)}`);
        }
        await wait(50);
      }
      check("repeated drags all land exactly, even after a lost release", ok && !clawd.controller.isHeld, misses.join(" ") || `work area ${JSON.stringify(area)}`);
      port.cursorPoint = realCursor;
    }

    // Inline chat: clicking Clawd opens a small terminal input under him; replies come in his pixel-terminal bubble.
    {
      clawd.controller.dismissSpeech();
      clawd.runCommand("open-chat");
      const opened = await waitFor(async () => (await js(companion, "!document.querySelector('#inputbar').hidden")) === true, 3_000);
      const geo = await js(
        companion,
        "(() => { const i = document.querySelector('#inputbar').getBoundingClientRect(); const c = document.querySelector('#character').getBoundingClientRect(); return { inputTop: i.top, inputH: i.height, charBottom: c.bottom, charTop: c.top, focused: document.activeElement === document.querySelector('#say') }; })()",
      );
      check("click opens the inline terminal input next to Clawd, focused", opened && geo.inputH > 20 && geo.inputH < 40 && geo.focused, JSON.stringify(geo));
      check("Clawd stays put while the input is open", (() => {
        const before = clawd.windows.getPosition();
        clawd.controller.machine.send("RESET");
        return clawd.controller.state === "idle" && JSON.stringify(clawd.windows.getPosition()) === JSON.stringify(before);
      })());
      await js(companion, "(() => { const i = document.querySelector('#say'); i.value = 'hello'; document.querySelector('#inputbar').requestSubmit(); })()");
      const answered = await waitFor(async () => (await js(companion, "!document.querySelector('#bubble').hidden && document.querySelector('#bubble-text').textContent.length > 3")) === true, 4_000);
      await wait(800);
      const style = await js(companion, "(() => { const b = getComputedStyle(document.querySelector('#bubble')); return { font: b.fontFamily, bg: b.backgroundColor, radius: b.borderRadius, text: document.querySelector('#bubble-text').textContent, src: document.querySelector('#bubble-source').textContent }; })()");
      check(
        "inline reply shows in a pixel-terminal bubble (VT323, dark, square corners, labeled offline)",
        answered && String(style.font).includes("VT323") && String(style.radius) === "0px" && /offline/i.test(String(style.src)),
        JSON.stringify(style).slice(0, 200),
      );
      await capture(companion, path.join(dir, "companion-inline.png"));
      await js(companion, "document.querySelector('#say').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
      check("Esc closes the inline input", await waitFor(async () => (await js(companion, "document.querySelector('#inputbar').hidden")) === true, 2_000));
    }

    // Chat window (offline mode, no API key in the smoke profile).
    clawd.runCommand("open-chat-window");
    const chat = clawd.windows.chat;
    check("chat window opens", !!chat);
    if (chat) {
      await waitFor(() => !chat.webContents.isLoading(), 8_000);
      await waitFor(async () => (await js(chat, "document.body.dataset.ready")) === "true", 5_000);
      await js(
        chat,
        "(() => { const i = document.querySelector('#input'); i.value = 'hello there'; document.querySelector('#composer').requestSubmit(); })()",
      );
      const replied = await waitFor(async () => (await js(chat, "document.querySelectorAll('.line.assistant').length")) >= 1, 5_000);
      check("offline chat reply rendered", replied);
      const label = await js(chat, "document.querySelector('.line.assistant .msg-source')?.textContent ?? ''");
      check("offline reply labeled as offline (not Claude)", /offline/i.test(String(label)) && /not from Claude/i.test(String(label)), String(label));
      const term = await js(chat, "({ title: document.querySelector('#titlebar .title')?.textContent, status: document.querySelector('#status')?.textContent, font: getComputedStyle(document.body).fontFamily, ready: document.fonts.check('20px VT323') })");
      check("chat is the retro terminal (title, status, pixel font)", /CLAWD:\/\/TERMINAL/.test(String(term.title)) && /OFFLINE|READY/.test(String(term.status)) && String(term.font).includes("VT323"), JSON.stringify(term));

      const typeCommand = (cmd: string) =>
        js(chat, `(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(cmd)}; document.querySelector('#composer').requestSubmit(); })()`);
      const lines = () => js(chat, "document.querySelectorAll('#screen .line').length") as Promise<number>;
      const before = await lines();
      await typeCommand("/help");
      check("/help prints the command list", await waitFor(async () => (await lines()) >= before + 2 && /\/remind/.test(String(await js(chat, "document.querySelector('#screen').textContent"))), 3_000));
      await typeCommand("/remind 10m stretch");
      const reminded = await waitFor(() => clawd.reminders.list().some((r) => r.text === "stretch"), 3_000);
      check("/remind adds a reminder", reminded);
      const r = clawd.reminders.list().find((x) => x.text === "stretch");
      if (r) clawd.reminders.remove(r.id);
      await typeCommand("/todo water the plants");
      const todoAdded = await waitFor(() => clawd.todos.list().some((t) => t.text === "water the plants"), 3_000);
      check("/todo adds a to-do", todoAdded);
      clawd.settings.update({ chatBoxColor: "#d97757" });
      await wait(300);
      clawd.runCommand("open-chat");
      await wait(300);
      const edge = await js(companion, "getComputedStyle(document.documentElement).getPropertyValue('--term-edge').trim()");
      check("chat box border color follows the setting", String(edge).toLowerCase() === "#d97757", String(edge));
      await wait(200);
      await capture(companion, path.join(dir, "companion-color.png"));
      clawd.windows.sendCompanion("companion:input", "close");
      if (clawd.windows.settings && !clawd.windows.settings.isDestroyed()) {
        clawd.windows.sendSettings("settings:navigate", "reminders");
        await wait(500);
        await capture(clawd.windows.settings, path.join(dir, "settings-reminders.png"));
      }
      for (const t of clawd.todos.list()) clawd.todos.remove(t.id);
      await typeCommand("/joke");
      check("/joke tells a joke and Clawd reacts", await waitFor(async () => /🥁/.test(String(await js(chat, "document.querySelector('#screen').textContent"))), 3_000));
      await wait(600); // let the reveal finish
      await capture(chat, path.join(dir, "chat.png"));
    }

    // Clawd import (real in-app path). Runs after the screenshots so imported art never appears in them.
    {
      const r = await clawd.importClawdFromClaudeApp();
      if (r.ok) {
        const pack = clawd.assets.info();
        const needed = ["idle", "walk", "pickup", "drag", "land", "think", "talk"] as const;
        const loadedInRenderer = await waitFor(async () => (await js(companion, "document.body.dataset.pack")) === "clawd" && (await js(companion, "document.body.dataset.spriteReady")) === "true", 5_000);
        check(
          "Clawd imported from the local Claude app and active",
          pack.id === "clawd" && needed.every((n) => !!pack.animations[n]) && r.skipped.length === 0 && loadedInRenderer,
          `${r.animations} animations, skipped ${r.skipped.length}`,
        );
        fs.rmSync(path.join(clawd.assets.userDir, "clawd"), { recursive: true, force: true });
      } else {
        check("Clawd import fails gracefully when the Claude app isn't installed", /wasn't found|format/i.test(r.error), r.error);
      }
    }

    // Opt-in live check (never in CI): one tiny real chat through the local Claude Code subscription.
    // Run with CLAWD_SMOKE_LIVE=1 npm run smoke. Uses a few tokens of the signed-in Claude plan.
    if (process.env.CLAWD_SMOKE_LIVE === "1") {
      clawd.settings.update({ aiProvider: "claude-code", aiEnabled: true });
      const conn = clawd.aiConnection();
      if (!conn) {
        check("live: Claude Code found for the subscription chat", false, "claude CLI not found");
      } else {
        const states: string[] = [];
        const off = clawd.controller.machine.onChange((next) => states.push(next));
        let reply = "";
        let source = "";
        let failed = "";
        // Watch chat events on their way to the chat window.
        const orig = clawd.windows.sendChat.bind(clawd.windows);
        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 90_000);
          clawd.windows.sendChat = (channel: string, payload: unknown) => {
            orig(channel, payload);
            const ev = payload as { type?: string; text?: string; message?: string };
            if (channel !== "chat:event") return;
            if (ev.type === "done") {
              reply = ev.text ?? "";
              clearTimeout(timer);
              resolve();
            }
            if (ev.type === "error") {
              failed = ev.message ?? "error";
              clearTimeout(timer);
              resolve();
            }
          };
        });
        const before = clawd.chat.transcript().length;
        clawd.sendInline("Reply with exactly the single word: pong");
        await done;
        clawd.windows.sendChat = orig;
        off();
        const last = clawd.chat.transcript().slice(before).find((t) => t.role === "assistant");
        source = last?.source ?? "";
        check(
          "live: subscription chat answers through Claude Code inside the app",
          !failed && /pong/i.test(reply) && source === "claude",
          failed || `${JSON.stringify(reply.slice(0, 60))} (${source})`,
        );
        check("live: Clawd thinks, then talks while the reply streams", states.includes("think") && states.includes("talk"), states.join(" → ").slice(0, 120));
        clawd.settings.update({ aiEnabled: false });
      }
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
