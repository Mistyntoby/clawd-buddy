import { app, Menu, powerMonitor, safeStorage, screen, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CompanionConfig, LinkKey, SettingsInit } from "../shared/api";
import { defaultPosition, effectiveWorkArea } from "../shared/movement";
import type { AiStatus, CapabilityInfo, ChatEvent, Settings } from "../shared/types";
import type { CompanionCommand, SettingsSection } from "../shared/validation";
import { AssetProvider } from "./asset-provider";
import { ChatService, type ChatHooks } from "./chat-service";
import type { AiConnection, StreamFactory } from "./claude-client";
import { findClaudeCli } from "./claude-code-client";
import { CompanionController } from "./companion-controller";
import { OfflineBrain } from "./offline-brain";
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
    this.secrets = new SecretStore(paths.userData, safeStorage);
    this.assets = new AssetProvider({
      userDir: path.join(paths.userData, "sprites"),
      devLocalDir: paths.devLocalSprites,
      placeholderDir: path.join(paths.resources, "sprites", "placeholder"),
    });
    this.windows = new WindowManager({
      preload: path.join(paths.distDir, "preload", "preload.js"),
      rendererDir: path.join(paths.distDir, "renderer"),
      icon: path.join(paths.resources, "icons", "icon.png"),
    });
    this.chat = new ChatService(streamFactory, this.offline, (e) => this.onChatEvent(e));
  }

  get isQuitting(): boolean {
    return this.quitting;
  }

  start(): void {
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
      { wandering: s.wandering, movementSpeed: s.movementSpeed, ambientComments: s.ambientComments },
      () => this.offline.idleComment(),
      { systemIdleSeconds: () => powerMonitor.getSystemIdleTime() },
    );
    this.controller.machine.onChange((next, prev) => {
      if (prev === "walk" && next !== "walk") this.savePositionSoon();
    });

    this.tray = new TrayController(this, path.join(this.paths.resources, "icons"));
    this.tray.create();

    this.settings.onChange((settings, changed) => this.onSettingsChanged(settings, changed));

    for (const ev of ["display-added", "display-removed", "display-metrics-changed"] as const) {
      screen.on(ev as "display-added", () => this.controller.ensureOnScreen());
    }
    powerMonitor.on("lock-screen", () => this.controller.pause());
    powerMonitor.on("unlock-screen", () => {
      if (this.windows.isVisible()) this.controller.resume();
    });

    this.applyLoginItem(s.launchAtStartup);
    if (s.openChatOnStartup) this.openChat();
  }

  private createCompanion(): void {
    const s = this.settings.get();
    const size = WindowManager.companionSizeFor(this.assets.info(), s.characterScale);
    const display = screen.getPrimaryDisplay();
    const start = s.position ?? defaultPosition(effectiveWorkArea(display.bounds, display.workArea), size);
    this.windows.createCompanion(size, start, s.alwaysOnTop, () => {
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
          `Hi! I'm ${s.companionName}, your desktop buddy. Double-click me to chat, right-click me for options, or find me in the system tray.`,
          "system",
        );
        this.windows.openSettings("welcome");
      }, 800);
    } else {
      setTimeout(() => this.controller.say(this.offline.greeting(s.personality), "offline", { sound: false }), 600);
    }
  }

  companionConfig(): CompanionConfig {
    const s = this.settings.get();
    return {
      scale: s.characterScale,
      showPlaceholderLabel: s.showPlaceholderLabel,
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
        this.openChat(true);
        break;
      case "open-chat":
        this.openChat();
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
        else this.controller.say(this.offline.fact(), "offline");
        break;
    }
  }

  openChat(focusInput = false): void {
    const win = this.windows.openChat(this.settings.get().chatAlwaysOnTop);
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
    const menu = Menu.buildFromTemplate([
      { label: `Talk to ${s.companionName}`, click: () => this.runCommand("talk") },
      { label: "Open chat", click: () => this.runCommand("open-chat") },
      { label: "Tell me something", click: () => this.runCommand("tell-me-something") },
      { label: "What can you help with?", click: () => this.runCommand("what-can-you-do") },
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
    if (refresh || this.cliPath === undefined) this.cliPath = findClaudeCli();
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
  }

  notifyAiStatusChanged(): void {
    this.windows.sendChat("chat:status-changed", null);
    this.windows.sendSettings("settings:changed", this.settingsInit());
  }

  // ---- settings -----------------------------------------------------------------------

  capabilities(): CapabilityInfo {
    const supported = app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
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

    if (has("wandering") || has("movementSpeed") || has("ambientComments")) {
      this.controller.updateSettings({ wandering: s.wandering, movementSpeed: s.movementSpeed, ambientComments: s.ambientComments });
    }
    if (has("alwaysOnTop")) this.windows.setAlwaysOnTop(s.alwaysOnTop);
    if (has("chatAlwaysOnTop")) this.windows.setChatAlwaysOnTop(s.chatAlwaysOnTop);
    if (has("launchAtStartup")) this.applyLoginItem(s.launchAtStartup);
    if (has("spritePack")) this.reloadAssets();
    if (has("characterScale")) {
      this.windows.resizeCompanion(WindowManager.companionSizeFor(this.assets.info(), s.characterScale));
      this.controller.ensureOnScreen();
    }
    if (has("characterScale") || has("showPlaceholderLabel") || has("soundEnabled") || has("companionName")) {
      this.windows.sendCompanion("companion:config", this.companionConfig());
    }
    if (has("aiEnabled") || has("aiProvider") || has("model") || has("companionName") || has("memoryEnabled")) {
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
    this.windows.resizeCompanion(WindowManager.companionSizeFor(pack, this.settings.get().characterScale));
    this.windows.sendCompanion("companion:pack", pack);
    this.controller?.ensureOnScreen();
    return { pack, packs: this.assets.listPacks() };
  }

  async openSpriteFolder(): Promise<void> {
    fs.mkdirSync(this.assets.userDir, { recursive: true });
    await shell.openPath(this.assets.userDir);
  }

  openLink(key: LinkKey): void {
    const url = LINKS[key];
    if (url) void shell.openExternal(url);
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
    this.controller?.dispose();
    if (this.positionSaveTimer) clearTimeout(this.positionSaveTimer);
    if (this.windows.companion) this.settings.update({ position: this.windows.getPosition() });
    this.settings.flush();
    this.tray?.destroy();
  }
}

export type { SettingsSection };
