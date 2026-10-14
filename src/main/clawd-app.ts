import { app, Menu, Notification, powerMonitor, safeStorage, screen, shell, type MenuItemConstructorOptions } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanionConfig, LinkKey, SettingsInit } from "../shared/api";
import { effectiveWorkArea, type Point, type Rng } from "../shared/movement";
import { resolveFallback } from "../shared/sprite-manifest";
import type { AiStatus, AnimationName, CapabilityInfo, ChatEvent, Settings } from "../shared/types";
import { extractRememberRequest, type CompanionCommand, type SettingsSection } from "../shared/validation";
import { AssetProvider } from "./asset-provider";
import { ChatService, type ChatHooks } from "./chat-service";
import { findClaudeDesktopAsar, loadClaudeDesktopSprites } from "./clawd-desktop-sprites";
import { buildClawdPack, CLAWD_PACK_ID, writeClawdPack } from "./clawd-import";
import type { AiConnection, StreamFactory } from "./claude-client";
import { findClaudeCli } from "./claude-code-client";
import { CompanionController } from "./companion-controller";
import { OfflineBrain } from "./offline-brain";
import { ReminderStore } from "./reminders";
import { TodoStore } from "./todos";
import { describeDue, parseReminder, type Reminder } from "../shared/reminders";
import { readJson, writeJsonAtomic } from "./settings";
import { platformAdapter, type PlatformAdapter } from "./platform";
import { SecretStore } from "./secure-storage";
import { defaultStreamFactory } from "./stream-factory";
import { MemoryStore, SettingsStore } from "./settings";
import { TrayController } from "./tray";
import { WindowManager } from "./window-manager";

export interface AppPaths {
  userData: string;
  /** Directory holding bundled resources (assets/ in dev, resources/ when packaged). */
  resources: string;
  distDir: string;
  devLocalSprites: string | null;
}

const LINKS: Record<LinkKey, string> = {
  console: "https://console.anthropic.com/settings/keys",
  claudeCode: "https://docs.anthropic.com/en/docs/claude-code/setup",
  pricing: "https://www.anthropic.com/pricing",
  docs: "https://docs.anthropic.com/",
  privacy: "https://www.anthropic.com/legal/privacy",
};

/**
 * Wires stores, windows, the companion controller, chat, and tray together.
 * Holds no UI logic of its own.
 */
export class ClawdApp {
  readonly settings: SettingsStore;
  readonly memory: MemoryStore;
  readonly secrets: SecretStore;
  readonly assets: AssetProvider;
  readonly windows: WindowManager;
  readonly offline = new OfflineBrain();
  readonly platform: PlatformAdapter = platformAdapter();
  readonly reminders: ReminderStore;
  readonly todos: TodoStore;
  private jokeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly chat: ChatService;
  controller!: CompanionController;
  private tray: TrayController | null = null;
  private quitting = false;
  private positionSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly paths: AppPaths,
    streamFactory: StreamFactory = defaultStreamFactory,
  ) {
    this.settings = new SettingsStore(paths.userData);
    this.memory = new MemoryStore(paths.userData);
    this.reminders = new ReminderStore(paths.userData);
    this.todos = new TodoStore(paths.userData);
    this.secrets = new SecretStore(paths.userData, safeStorage);
    this.assets = new AssetProvider({
      userDir: path.join(paths.userData, "sprites"),
      devLocalDir: paths.devLocalSprites,
      placeholderDir: path.join(paths.resources, "sprites", "placeholder"),
    });
    this.windows = new WindowManager(
      {
        preload: path.join(paths.distDir, "preload", "preload.js"),
        rendererDir: path.join(paths.distDir, "renderer"),
        icon: path.join(paths.resources, "icons", "icon.png"),
      },
      this.platform,
    );
    this.chat = new ChatService(streamFactory, this.offline, (e) => this.onChatEvent(e));
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  start(): void {
    this.platform.onReady();
    const s = this.settings.get();
    this.assets.reload(s.spritePack);
    try {
      fs.mkdirSync(this.assets.userDir, { recursive: true });
    } catch {
      /* non-fatal: the folder is only a convenience */
    }

    this.createCompanion();
    this.controller = new CompanionController(
      this.windows,
      this.controllerSettings(s),
      () => this.offline.idleComment(),
      {
        systemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
        chooseAnimation: (name, rng) => this.chooseAnimation(name, rng),
        onDrop: () => this.afterDrop(),
      },
    );
    this.controller.machine.onChange((next, prev) => {
      if (prev === "walk" && next !== "walk") this.savePositionSoon();
    });

    this.tray = new TrayController(this, path.join(this.paths.resources, "icons"), this.platform);
    this.tray.create();

    this.settings.onChange((settings, changed) => this.onSettingsChanged(settings, changed));

    for (const ev of ["display-added", "display-removed", "display-metrics-changed"] as const) {
      screen.on(ev as "display-added", () => {
        this.relayout();
        this.controller.ensureOnScreen();
      });
    }
    powerMonitor.on("lock-screen", () => this.controller.pause());
    powerMonitor.on("unlock-screen", () => {
      if (this.windows.isVisible()) this.controller.resume();
    });

    this.applyChatPersistence(s.keepChatHistory);
    this.reminders.start(
      (r) => this.reminderDue(r),
      () => {
        this.windows.sendSettings("reminders:changed", null);
        this.windows.sendChat("reminders:changed", null);
      },
    );

    this.todos.watch(() => {
      this.windows.sendSettings("todos:changed", null);
      this.windows.sendChat("todos:changed", null);
    });

    this.applyLoginItem(s.launchAtStartup);
    if (s.openChatOnStartup) this.openChat();
  }

  // ---- chat history ------------------------------------------------------------

  private applyChatPersistence(on: boolean): void {
    const file = path.join(this.paths.userData, "chat-history.json");
    if (!on) {
      this.chat.setPersistence(null);
      fs.rmSync(file, { force: true });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: unknown = null;
    this.chat.setPersistence({
      load: () => readJson(file) as never,
      save: (data) => {
        pending = data;
        if (timer) return;
        // Coalesce bursts of writes (a reply and its notices) into one small file write.
        timer = setTimeout(() => {
          timer = null;
          try {
            if (pending === null) fs.rmSync(file, { force: true });
            else writeJsonAtomic(file, pending);
          } catch {
            console.warn("[chat] Could not save chat history.");
          }
        }, 300);
      },
    });
  }

  // ---- reminders, jokes, facts, petting, tricks ----------------------------------

  private reminderDue(r: Reminder): void {
    const text = `⏰ Reminder: ${r.text}`;
    this.chat.notice({ role: "system", text });
    if (this.windows.isVisible()) {
      this.controller.say(text, "system");
      this.controller.wave();
    } else if (Notification.isSupported()) {
      new Notification({ title: "Clawd Buddy reminder", body: r.text, silent: !this.settings.get().soundEnabled }).show();
    }
  }

  /** Adds a reminder from text like "10m stretch". */
  addReminder(spec: string): { ok: true; message: string } | { ok: false; error: string } {
    const parsed = parseReminder(typeof spec === "string" ? spec : "", Date.now());
    if (!parsed.ok) return parsed;
    const r = this.reminders.add(parsed.text, parsed.dueAt);
    if (!r.ok) return r;
    return { ok: true, message: `Okay! I'll remind you ${describeDue(parsed.dueAt, Date.now())}: ${parsed.text}` };
  }

  /** Setup, a beat, then the punchline with a happy reaction. */
  tellJoke(toChat = false): void {
    const [setup, punchline] = this.offline.joke();
    if (this.jokeTimer) clearTimeout(this.jokeTimer);
    this.controller.say(setup, "offline");
    this.jokeTimer = setTimeout(() => {
      this.jokeTimer = null;
      this.controller.say(`${setup}\n${punchline}`, "offline", { sound: false });
      this.controller.celebrate();
    }, 2400);
    if (toChat) this.chat.notice({ role: "assistant", text: `${setup}\n${punchline} 🥁`, source: "offline" });
  }

  tellFact(toChat = false): void {
    const fact = this.offline.fact();
    this.controller.say(fact, "offline");
    this.controller.idea();
    if (toChat) this.chat.notice({ role: "assistant", text: fact, source: "offline" });
  }

  pet(): void {
    if (!this.controller.pet()) return;
    const lines = ["Hehe! 🧡", "That tickles!", "*happy crab noises*", "More scritches, please!", "♥"];
    this.controller.say(lines[Math.floor(Math.random() * lines.length)] as string, "system", { sound: false });
  }

  /** Labeled animations in the active sprite pack, for the "Do a trick" menu. */
  tricks(): { label: string; state: "happy" | "action" | "wave" | "idea" | "idle-variation"; variant: number }[] {
    const pack = this.assets.info();
    const out: { label: string; state: "happy" | "action" | "wave" | "idea" | "idle-variation"; variant: number }[] = [];
    for (const state of ["wave", "happy", "action", "idea", "idle-variation"] as const) {
      const anim = pack.animations[state];
      if (!anim) continue;
      [anim, ...anim.variants].forEach((seq, variant) => {
        if (seq.label) out.push({ label: seq.label, state, variant });
      });
    }
    return out;
  }

  /** Handles chat input starting with "/". Output goes to the chat as local notices. */
  private runChatCommand(input: string): void {
    const [cmdRaw, ...args] = input.trim().split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase();
    const arg = args.join(" ");
    // Echo the command, then the result, as local chat lines; without the chat window, Clawd says it too.
    const say = (text: string) => {
      this.chat.notice({ role: "system", text }, input.trim());
      if (!this.chatWindowActive()) this.controller.say(text, "system", { sound: false });
    };
    switch (cmd) {
      case "/help":
        return say(
          [
            "COMMANDS",
            "/joke         a joke",
            "/fact         a fun fact",
            "/pet          pat Clawd",
            "/trick [name] do a trick",
            "/remind 10m tea",
            "/remind at 15:30 call",
            "/reminders    list them",
            "/done N       finish one",
            "/forget N     delete one",
            "/todo buy milk  add a to-do",
            "/todo         list to-dos",
            "/todo done N  tick one off",
            "/search words web search",
            "/clear        clear chat",
            "Anything else goes to Claude.",
          ].join("\n"),
        );
      case "/joke":
        this.chat.notice({ role: "user", text: input });
        return this.tellJoke(true);
      case "/fact":
        this.chat.notice({ role: "user", text: input });
        return this.tellFact(true);
      case "/pet":
        this.pet();
        return say("*pat pat* 🧡");
      case "/remind": {
        const r = this.addReminder(arg);
        return say(r.ok ? r.message : r.error);
      }
      case "/reminders": {
        const list = this.reminders.list();
        if (list.length === 0) return say("No reminders. Try /remind 10m stretch");
        const now = Date.now();
        return say(list.map((r, i) => `${i + 1}. ${r.text}  (${r.status === "fired" ? "due now" : describeDue(r.dueAt, now)})`).join("\n"));
      }
      case "/done":
      case "/forget": {
        const r = this.reminders.list()[Number(arg) - 1];
        if (!r) return say("Which one? Use the number from /reminders.");
        if (cmd === "/done") this.reminders.dismiss(r.id);
        else this.reminders.remove(r.id);
        return say(`${cmd === "/done" ? "Done" : "Deleted"}: ${r.text}`);
      }
      case "/todo":
      case "/todos": {
        const [sub, ...restArgs] = args;
        const rest = restArgs.join(" ");
        const list = () => this.todos.list();
        if (!arg) {
          const items = list();
          if (items.length === 0) return say("No to-dos. Add one: /todo buy milk");
          return say(items.map((t, i) => `${i + 1}. [${t.done ? "x" : " "}] ${t.text}`).join("\n"));
        }
        const pick = () => list()[Number(rest) - 1];
        switch ((sub ?? "").toLowerCase()) {
          case "done":
          case "undo": {
            const t = pick();
            if (!t) return say("Which one? Use the number from /todo.");
            this.todos.setDone(t.id, sub?.toLowerCase() === "done");
            if (sub?.toLowerCase() === "done") this.controller.celebrate();
            return say(`${sub?.toLowerCase() === "done" ? "Done" : "Reopened"}: ${t.text}`);
          }
          case "forget":
          case "delete": {
            const t = pick();
            if (!t) return say("Which one? Use the number from /todo.");
            this.todos.remove(t.id);
            return say(`Deleted: ${t.text}`);
          }
          case "clear": {
            const n = this.todos.clearDone();
            return say(n ? `Cleared ${n} finished to-do${n === 1 ? "" : "s"}.` : "Nothing finished to clear.");
          }
          default: {
            const r = this.todos.add(sub?.toLowerCase() === "add" ? rest : arg);
            return say(r.ok ? `Added to-do: ${r.todo.text}` : r.error);
          }
        }
      }
      case "/trick": {
        const tricks = this.tricks();
        if (tricks.length === 0) return say("This sprite pack has no named tricks.");
        const wanted = arg.toLowerCase();
        const t = wanted ? tricks.find((x) => x.label.toLowerCase().includes(wanted)) : undefined;
        if (!t) return say(`Tricks: ${tricks.map((x) => x.label).join(", ")}`);
        this.controller.perform(t.state, t.variant);
        return say(`*${t.label.toLowerCase()}*`);
      }
      case "/search": {
        if (!arg) return say("Search for what? e.g. /search pixel art crabs");
        void shell.openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(arg.slice(0, 300))}`);
        return say(`Opened a web search for "${arg.slice(0, 80)}" in your browser.`);
      }
      case "/clear":
        this.chat.clear();
        this.windows.sendChat("chat:cleared", null);
        if (!this.chatWindowActive()) this.controller.say("Chat cleared.", "system", { sound: false });
        return;
      default:
        return say(`Unknown command ${cmd}. Type /help for the list.`);
    }
  }

  private createCompanion(): void {
    const s = this.settings.get();
    const display = screen.getPrimaryDisplay();
    const near = s.position ?? { x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + display.workArea.height / 2 };
    const layout = WindowManager.layoutFor(this.assets.info(), s.characterScale, near);
    const area = effectiveWorkArea(display.bounds, display.workArea);
    const start = s.position ?? {
      x: area.x + area.width - 24 - (layout.body.x + layout.body.width),
      y: area.y + area.height - (layout.body.y + layout.body.height),
    };
    this.windows.createCompanion(layout, start, s.alwaysOnTop, () => {
      if (!this.quitting) {
        // The companion window should never disappear for good; recreate it.
        setTimeout(() => this.createCompanion(), 500);
      }
    });
  }

  /** Called by the companion renderer once it is ready to draw. */
  companionReady(): void {
    const s = this.settings.get();
    const p = this.controller.ensureOnScreen(s.position);
    if (!s.position) this.settings.update({ position: p });
    this.controller.start();
    if (!s.firstRunComplete) {
      this.settings.update({ firstRunComplete: true });
      setTimeout(() => {
        this.controller.say(
          `Hi! I'm ${s.companionName}, your desktop buddy. Click me to chat, drag me anywhere, right-click me for jokes, facts, and reminders.`,
          "system",
        );
        this.windows.openSettings("welcome");
      }, 800);
    } else {
      setTimeout(() => {
        this.controller.wave();
        this.controller.say(this.offline.greeting(s.personality), "offline", { sound: false });
      }, 600);
    }
  }

  /**
   * Re-computes the companion geometry (sprite scale, display scale factor)
   * and applies it if it changed. Never runs while Clawd is held.
   */
  relayout(): void {
    if (!this.windows.companion || this.controller?.isHeld) return;
    const pos = this.windows.getPosition();
    const size = this.windows.getSize();
    const center: Point = { x: pos.x + size.width / 2, y: pos.y + size.height / 2 };
    this.windows.setLayout(WindowManager.layoutFor(this.assets.info(), this.settings.get().characterScale, center));
  }

  private controllerSettings(s: Settings) {
    return { wandering: s.wandering, movementSpeed: s.movementSpeed, idleChatter: s.idleChatter, animationIntensity: s.animationIntensity };
  }

  /** Picks a variant of an animation in the active pack and how long it plays once. */
  private chooseAnimation(name: AnimationName, rng: Rng): { variant: number; durationMs: number | null } {
    const pack = this.assets.info();
    const resolved = resolveFallback(name, new Set(Object.keys(pack.animations) as AnimationName[]));
    const anim = resolved ? pack.animations[resolved] : undefined;
    if (!anim) return { variant: 0, durationMs: null };
    const sequences = [anim, ...anim.variants];
    const variant = Math.min(sequences.length - 1, Math.floor(rng() * sequences.length));
    const seq = sequences[variant] ?? anim;
    // A stand-in animation (e.g. idle for a missing "land") doesn't define how long the state lasts.
    const durationMs = resolved === name ? Math.round((seq.frameCount / seq.fps) * 1000) : null;
    return { variant, durationMs };
  }

  /** After a drop: persist right away, and re-check pixel scale in case Clawd moved to another display. */
  afterDrop(): void {
    this.relayout();
    this.savePositionNow();
  }

  companionConfig(): CompanionConfig {
    const s = this.settings.get();
    return {
      scale: s.characterScale,
      reducedMotion: s.reducedMotion,
      chatBoxColor: s.chatBoxColor,
      animationIntensity: s.animationIntensity,
      soundEnabled: s.soundEnabled,
      name: s.companionName,
    };
  }

  // ---- visibility ----------------------------------------------------------------

  showCompanion(): void {
    this.windows.showCompanion();
    this.controller.ensureOnScreen();
    this.controller.resume();
    this.tray?.refresh();
  }

  hideCompanion(): void {
    this.controller.pause();
    this.controller.dismissSpeech();
    this.windows.hideCompanion();
    this.tray?.refresh();
    this.tray?.notifyHidden();
  }

  toggleCompanion(): void {
    if (this.windows.isVisible()) this.hideCompanion();
    else this.showCompanion();
  }

  // ---- commands --------------------------------------------------------------------

  runCommand(cmd: CompanionCommand): void {
    switch (cmd) {
      case "poke":
        this.controller.poke();
        break;
      case "talk":
      case "open-chat":
        // Clicking Clawd: the inline input under him, or the terminal window, per Settings.
        if (this.settings.get().chatMode === "inline") this.toggleInlineChat();
        else this.openChat(true);
        break;
      case "open-chat-window":
        this.windows.sendCompanion("companion:input", "close");
        this.openChat(true);
        break;
      case "open-settings":
        this.windows.openSettings();
        break;
      case "hide":
        this.hideCompanion();
        break;
      case "what-can-you-do":
        this.controller.say(this.offline.help(), "system");
        break;
      case "tell-me-something":
        if (this.aiReady()) void this.sendChat("Tell me something interesting or fun, in two or three sentences.");
        else this.tellFact();
        break;
      case "pet":
        this.pet();
        break;
      case "joke":
        this.tellJoke();
        break;
      case "fact":
        this.tellFact();
        break;
      case "reminders":
        this.windows.openSettings("reminders");
        break;
    }
  }

  /** Shows or hides the small terminal input under Clawd and gives his window keyboard focus. */
  toggleInlineChat(): void {
    this.windows.sendCompanion("companion:input", "toggle");
    this.windows.focusCompanion();
  }

  /** The chat window is in use (open and not minimized); otherwise command output goes to Clawd's bubble. */
  private chatWindowActive(): boolean {
    const w = this.windows.chat;
    return !!w && !w.isDestroyed() && w.isVisible() && !w.isMinimized();
  }

  /** A message typed into the inline input under Clawd. */
  sendInline(text: string): { ok: true } | { ok: false; error: string } {
    if (extractRememberRequest(text)) {
      // Saving to memory needs the approval card in the chat window.
      this.openChat(true);
      const win = this.windows.chat;
      if (win) {
        const send = () => win.webContents.send("chat:submit", text);
        if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
        else send();
      }
      return { ok: true };
    }
    void this.sendChat(text);
    return { ok: true };
  }

  openChat(focusInput = false): void {
    const wasOpen = !!this.windows.chat && !this.windows.chat.isDestroyed();
    const win = this.windows.openChat(this.settings.get().chatAlwaysOnTop);
    if (!wasOpen) this.controller.wave();
    if (focusInput) {
      const send = () => win.webContents.send("chat:focus-input");
      if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
      else send();
    }
  }

  showContextMenu(): void {
    const win = this.windows.companion;
    if (!win) return;
    this.controller.noteInteraction();
    const s = this.settings.get();
    const tricks = this.tricks();
    const menu = Menu.buildFromTemplate([
      { label: "Chat", click: () => this.runCommand("talk") },
      { label: "Open chat window", click: () => this.runCommand("open-chat-window") },
      { label: "Tell a joke", click: () => this.runCommand("joke") },
      { label: "Fun fact", click: () => this.runCommand("fact") },
      { label: `Pet ${s.companionName}`, click: () => this.runCommand("pet") },
      ...(tricks.length > 0
        ? [
            {
              label: "Do a trick",
              submenu: tricks.map((t) => ({ label: t.label, click: () => this.controller.perform(t.state, t.variant) })),
            } satisfies MenuItemConstructorOptions,
          ]
        : []),
      { label: "Reminders & to-dos…", click: () => this.runCommand("reminders") },
      { type: "separator" },
      { label: "Wander around", type: "checkbox", checked: s.wandering, click: (i) => this.settings.update({ wandering: i.checked }) },
      {
        label: "Movement speed",
        submenu: (["slow", "normal", "fast"] as const).map((speed) => ({
          label: speed[0]!.toUpperCase() + speed.slice(1),
          type: "radio" as const,
          checked: s.movementSpeed === speed,
          click: () => this.settings.update({ movementSpeed: speed }),
        })),
      },
      { label: "Sounds", type: "checkbox", checked: s.soundEnabled, click: (i) => this.settings.update({ soundEnabled: i.checked }) },
      { type: "separator" },
      { label: "Settings…", click: () => this.windows.openSettings() },
      { label: `Hide ${s.companionName}`, click: () => this.hideCompanion() },
      { label: "Quit Clawd Buddy", click: () => this.quit() },
    ]);
    menu.popup({ window: win });
  }

  // ---- chat --------------------------------------------------------------------------

  private cliPath: string | null | undefined;

  /** Path of the Claude Code CLI, looked up once and again on request (e.g. after installing it). */
  claudeCodePath(refresh = false): string | null {
    if (refresh || this.cliPath === undefined) {
      this.cliPath = findClaudeCli({
        env: process.env,
        platform: process.platform,
        home: os.homedir(),
        isFile: (p) => {
          try {
            return fs.statSync(p).isFile();
          } catch {
            return false;
          }
        },
        extraDirs: this.platform.claudeCliDirs(os.homedir()),
      });
    }
    return this.cliPath;
  }

  /** Empty folder the CLI runs in, so it never picks up project files or CLAUDE.md. */
  private claudeCodeWorkDir(): string {
    const dir = path.join(this.paths.userData, "claude-code");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** How chat reaches Claude right now, or null when replies are offline. */
  aiConnection(): AiConnection | null {
    const s = this.settings.get();
    if (!s.aiEnabled) return null;
    if (s.aiProvider === "claude-code") {
      const cliPath = this.claudeCodePath();
      return cliPath ? { provider: "claude-code", cliPath, workDir: this.claudeCodeWorkDir() } : null;
    }
    const { key } = this.secrets.getApiKey();
    return key ? { provider: "api", apiKey: key } : null;
  }

  aiReady(): boolean {
    return this.aiConnection() !== null;
  }

  aiStatus(): AiStatus {
    const s = this.settings.get();
    const { key, source } = this.secrets.getApiKey();
    const found = this.claudeCodePath() !== null;
    return {
      enabled: s.aiEnabled,
      provider: s.aiProvider,
      ready: s.aiEnabled && (s.aiProvider === "claude-code" ? found : key !== null),
      hasKey: key !== null,
      claudeCodeFound: found,
      keySource: source,
      secureStorageAvailable: this.secrets.encryptionAvailable,
      model: s.model,
    };
  }

  async sendChat(text: string) {
    if (text.trim().startsWith("/")) {
      this.runChatCommand(text);
      return { ok: true as const, requestId: "local" };
    }
    const s = this.settings.get();
    const hooks: ChatHooks = {
      onThinking: () => this.controller.chatThinking(),
      onFirstToken: () => this.controller.chatFirstToken(),
      onDone: (reply, source) => this.controller.chatDone(reply, source),
      onError: (message) => this.controller.chatError(message),
      onCancelled: () => this.controller.chatCancelled(),
    };
    return this.chat.send(
      text,
      {
        connection: this.aiConnection(),
        model: s.model,
        name: s.companionName,
        personality: s.personality,
        memory: s.memoryEnabled ? this.memory.list() : null,
      },
      hooks,
    );
  }

  private onChatEvent(event: ChatEvent): void {
    this.windows.sendChat("chat:event", event);
    if (event.type === "delta") this.controller.chatDelta(event.text);
    // The inline input shows a tiny status too.
    const state =
      event.type === "start" ? (event.source === "claude" ? "thinking" : "ready") : event.type === "delta" ? "typing" : event.type === "notice" ? null : "ready";
    if (state) this.windows.sendCompanion("companion:chat-state", state);
  }

  notifyAiStatusChanged(): void {
    this.windows.sendChat("chat:status-changed", null);
    this.windows.sendSettings("settings:changed", this.settingsInit());
  }

  // ---- settings -----------------------------------------------------------------------

  capabilities(): CapabilityInfo {
    const supported = this.platform.launchAtStartupSupported(app.isPackaged);
    return {
      launchAtStartupSupported: supported,
      launchAtStartupReason: supported
        ? null
        : app.isPackaged
          ? "Launch at startup isn't supported on this operating system yet."
          : "Launch at startup is only available in the installed app (not when running from source).",
      platform: process.platform,
      version: app.getVersion(),
    };
  }

  settingsInit(): SettingsInit {
    return { settings: this.settings.get(), capabilities: this.capabilities(), ai: this.aiStatus() };
  }

  private onSettingsChanged(s: Settings, changed: (keyof Settings)[]): void {
    const has = (k: keyof Settings) => changed.includes(k);
    if (changed.length === 1 && has("position")) return;

    if (has("wandering") || has("movementSpeed") || has("idleChatter") || has("animationIntensity")) {
      this.controller.updateSettings(this.controllerSettings(s));
    }
    if (has("alwaysOnTop")) this.windows.setAlwaysOnTop(s.alwaysOnTop);
    if (has("chatAlwaysOnTop")) this.windows.setChatAlwaysOnTop(s.chatAlwaysOnTop);
    if (has("launchAtStartup")) this.applyLoginItem(s.launchAtStartup);
    if (has("keepChatHistory")) this.applyChatPersistence(s.keepChatHistory);
    if (has("spritePack")) this.reloadAssets();
    if (has("characterScale")) {
      this.relayout();
      this.controller.ensureOnScreen();
    }
    if (has("characterScale") || has("reducedMotion") || has("animationIntensity") || has("soundEnabled") || has("companionName") || has("chatBoxColor")) {
      this.windows.sendCompanion("companion:config", this.companionConfig());
    }
    if (has("aiEnabled") || has("aiProvider") || has("model") || has("companionName") || has("memoryEnabled") || has("readAloud") || has("reducedMotion")) {
      this.windows.sendChat("chat:status-changed", null);
    }
    this.windows.sendSettings("settings:changed", this.settingsInit());
    this.tray?.refresh();
  }

  private applyLoginItem(on: boolean): void {
    if (!this.capabilities().launchAtStartupSupported) return;
    try {
      app.setLoginItemSettings({ openAtLogin: on });
    } catch {
      console.warn("[app] Could not update the launch-at-startup setting.");
    }
  }

  reloadAssets() {
    const pack = this.assets.reload(this.settings.get().spritePack);
    this.windows.sendCompanion("companion:pack", pack);
    if (this.controller) this.relayout();
    this.controller?.ensureOnScreen();
    return { pack, packs: this.assets.listPacks() };
  }

  /**
   * Reads Clawd's original animations from the Claude desktop app installed on
   * this computer (read-only) and saves them as a private sprite pack in the
   * user's sprite folder. Nothing is uploaded or added to the project.
   */
  async importClawdFromClaudeApp(): Promise<{ ok: true; animations: number; skipped: string[] } | { ok: false; error: string }> {
    try {
      const asar = findClaudeDesktopAsar(await this.platform.claudeDesktopArchives(process.env));
      if (!asar) return { ok: false, error: "The Claude desktop app wasn't found on this computer. Install it from claude.ai/download, then try again." };
      const version = /Claude_([\d.]+)_/.exec(asar)?.[1];
      const built = buildClawdPack(loadClaudeDesktopSprites(asar));
      fs.mkdirSync(this.assets.userDir, { recursive: true });
      writeClawdPack(built, this.assets.userDir, `Claude desktop app${version ? ` ${version}` : ""} on this computer, imported ${new Date().toISOString().slice(0, 10)}`);
      if (this.settings.get().spritePack !== "auto") this.settings.update({ spritePack: CLAWD_PACK_ID });
      else this.reloadAssets();
      this.controller.celebrate();
      if (built.skipped.length > 0) console.warn(`[sprites] Clawd import skipped ${built.skipped.length} sequence(s).`);
      return { ok: true, animations: Object.keys(built.animations).length, skipped: built.skipped };
    } catch (err) {
      this.controller.flinch();
      return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
    }
  }

  async openSpriteFolder(): Promise<void> {
    fs.mkdirSync(this.assets.userDir, { recursive: true });
    await shell.openPath(this.assets.userDir);
  }

  openLink(key: LinkKey): void {
    const url = LINKS[key];
    if (url) void shell.openExternal(url);
  }

  savePositionNow(): void {
    if (this.positionSaveTimer) clearTimeout(this.positionSaveTimer);
    this.positionSaveTimer = null;
    if (this.windows.companion) this.settings.update({ position: this.windows.getPosition() });
  }

  savePositionSoon(): void {
    if (this.positionSaveTimer) clearTimeout(this.positionSaveTimer);
    this.positionSaveTimer = setTimeout(() => {
      this.positionSaveTimer = null;
      if (this.windows.companion) this.settings.update({ position: this.windows.getPosition() });
    }, 1000);
  }

  // ---- lifecycle -------------------------------------------------------------------------

  quit(): void {
    this.quitting = true;
    app.quit();
  }

  /** Called from before-quit: stop everything and persist state. */
  shutdown(): void {
    this.quitting = true;
    this.chat.cancel();
    this.reminders.stop();
    if (this.jokeTimer) clearTimeout(this.jokeTimer);
    this.controller?.dispose();
    if (this.positionSaveTimer) clearTimeout(this.positionSaveTimer);
    if (this.windows.companion) this.settings.update({ position: this.windows.getPosition() });
    this.settings.flush();
    this.tray?.destroy();
  }
}

export type { SettingsSection };
