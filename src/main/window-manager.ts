import { BrowserWindow, screen, shell, type WebContents } from "electron";
import * as path from "node:path";
import { companionLayout, type CompanionLayout } from "../shared/layout";
import { effectiveWorkArea, type Point, type Rect, type Size } from "../shared/movement";
import type { CompanionView, SpeechPayload, SpritePackInfo } from "../shared/types";
import type { CompanionPort } from "./companion-controller";
import type { PlatformAdapter } from "./platform";

export type WindowRole = "companion" | "chat" | "settings";

export interface WindowPaths {
  preload: string;
  rendererDir: string;
  icon: string;
}

/**
 * Creates and tracks the three app windows. All windows use context
 * isolation, the sandbox, and no Node integration; they can only talk to the
 * main process through the narrow preload API.
 */
export class WindowManager implements CompanionPort {
  companion: BrowserWindow | null = null;
  chat: BrowserWindow | null = null;
  settings: BrowserWindow | null = null;
  private layout: CompanionLayout = companionLayout({ frameWidth: 32, frameHeight: 32, bodyBox: [0, 0, 32, 32], scale: 3, scaleFactor: 1 });
  private interactive = false;
  private onCompanionClosedCb: (() => void) | null = null;

  constructor(
    private readonly paths: WindowPaths,
    private readonly platform: PlatformAdapter,
  ) {}

  roleOf(contents: WebContents): WindowRole | null {
    if (this.companion && !this.companion.isDestroyed() && contents.id === this.companion.webContents.id) return "companion";
    if (this.chat && !this.chat.isDestroyed() && contents.id === this.chat.webContents.id) return "chat";
    if (this.settings && !this.settings.isDestroyed() && contents.id === this.settings.webContents.id) return "settings";
    return null;
  }

  private secureWebPreferences(): Electron.WebPreferences {
    return {
      preload: this.paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !process.env.CLAWD_NO_DEVTOOLS,
    };
  }

  /** Blocks navigation and new windows; only https links open, in the user's browser. */
  private harden(win: BrowserWindow): void {
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  }

  private load(win: BrowserWindow, name: string): void {
    void win.loadFile(path.join(this.paths.rendererDir, name, "index.html"));
  }

  /** Geometry for a pack at a scale, on the display at `near` (its scale factor keeps pixels crisp). */
  static layoutFor(pack: SpritePackInfo, scale: number, near: Point): CompanionLayout {
    let scaleFactor = 1;
    try {
      scaleFactor = screen.getDisplayNearestPoint(near).scaleFactor;
    } catch {
      /* fall back to 1 */
    }
    return companionLayout({ frameWidth: pack.frameWidth, frameHeight: pack.frameHeight, bodyBox: pack.bodyBox, scale, scaleFactor });
  }

  get companionLayout(): CompanionLayout {
    return this.layout;
  }

  createCompanion(layout: CompanionLayout, position: Point, alwaysOnTop: boolean, onClosed: () => void): BrowserWindow {
    this.layout = layout;
    const size = layout.window;
    this.onCompanionClosedCb = onClosed;
    const win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: position.x,
      y: position.y,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop,
      show: false,
      title: "Clawd Buddy",
      backgroundColor: "#00000000",
      icon: this.paths.icon,
      ...this.platform.companionWindowOptions(),
      webPreferences: { ...this.secureWebPreferences(), backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
    });
    this.harden(win);
    this.platform.setAlwaysOnTop(win, alwaysOnTop);
    // Click-through by default; the renderer turns interaction on while the pointer is over the character.
    win.setIgnoreMouseEvents(true, { forward: true });
    this.interactive = false;
    win.once("ready-to-show", () => win.showInactive());
    win.on("closed", () => {
      this.companion = null;
      this.onCompanionClosedCb?.();
    });
    this.load(win, "companion");
    this.companion = win;
    return win;
  }

  /** Applies a new layout, keeping Clawd's feet where they are (bottom-center anchor). */
  setLayout(layout: CompanionLayout): void {
    const prev = this.layout;
    this.layout = layout;
    const size = layout.window;
    const win = this.companion;
    if (!win || win.isDestroyed()) return;
    if (prev.window.width === size.width && prev.window.height === size.height) {
      this.sendToCompanion("companion:layout", layout);
      return;
    }
    const old = win.getBounds();
    // Keep the character's feet in place: anchor bottom-center.
    const x = Math.round(old.x + (old.width - size.width) / 2);
    const y = old.y + old.height - size.height;
    win.setBounds({ x, y, width: size.width, height: size.height });
    this.sendToCompanion("companion:layout", layout);
  }

  /** Whether the companion window currently accepts mouse input (false = click-through). */
  get companionInteractive(): boolean {
    return this.interactive;
  }

  setCompanionInteractive(on: boolean): void {
    const win = this.companion;
    if (!win || win.isDestroyed() || on === this.interactive) return;
    this.interactive = on;
    if (on) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  }

  showCompanion(): void {
    const win = this.companion;
    if (!win || win.isDestroyed()) return;
    win.showInactive();
  }

  hideCompanion(): void {
    this.companion?.hide();
  }

  setAlwaysOnTop(on: boolean): void {
    const win = this.companion;
    if (win && !win.isDestroyed()) this.platform.setAlwaysOnTop(win, on);
  }

  // ---- CompanionPort ---------------------------------------------------------

  getPosition(): Point {
    const win = this.companion;
    if (!win || win.isDestroyed()) return { x: 0, y: 0 };
    const [x = 0, y = 0] = win.getPosition();
    return { x, y };
  }

  setPosition(p: Point): void {
    const win = this.companion;
    if (!win || win.isDestroyed()) return;
    // setBounds keeps the size fixed even across DPI changes between monitors.
    win.setBounds({ x: Math.round(p.x), y: Math.round(p.y), ...this.layout.window });
  }

  getSize(): Size {
    return { ...this.layout.window };
  }

  bodyRect(): Rect {
    return { ...this.layout.body };
  }

  /** Cursor position in DIP: the same coordinate space as BrowserWindow bounds on every OS. */
  cursorPoint(): Point {
    return screen.getCursorScreenPoint();
  }

  isVisible(): boolean {
    return !!this.companion && !this.companion.isDestroyed() && this.companion.isVisible();
  }

  workAreas(): Rect[] {
    return screen.getAllDisplays().map((d) => d.workArea);
  }

  workAreaNear(p: Point): Rect {
    let d: Electron.Display;
    try {
      d = screen.getDisplayNearestPoint(p);
    } catch {
      d = screen.getPrimaryDisplay();
    }
    return effectiveWorkArea(d.bounds, d.workArea);
  }

  private sendToCompanion(channel: string, payload: unknown): void {
    const win = this.companion;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  sendView(view: CompanionView): void {
    this.sendToCompanion("companion:view", view);
  }

  sendSpeech(speech: SpeechPayload | null): void {
    this.sendToCompanion("companion:speech", speech);
  }

  sendSound(sound: "pop" | "chime" | "blip" | "error"): void {
    this.sendToCompanion("companion:sound", sound);
  }

  sendCompanion(channel: string, payload: unknown): void {
    this.sendToCompanion(channel, payload);
  }

  // ---- chat & settings windows ----------------------------------------------------

  openChat(alwaysOnTop: boolean): BrowserWindow {
    if (this.chat && !this.chat.isDestroyed()) {
      if (this.chat.isMinimized()) this.chat.restore();
      this.chat.show();
      this.chat.focus();
      return this.chat;
    }
    const bounds = this.chatBoundsNearCompanion({ width: 380, height: 440 });
    // A small frameless "terminal": its own pixel title bar is the drag handle and holds minimize/close.
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 300,
      minHeight: 260,
      title: "CLAWD://TERMINAL",
      frame: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#0d0f0c",
      alwaysOnTop,
      fullscreenable: false,
      maximizable: false,
      roundedCorners: false,
      icon: this.paths.icon,
      webPreferences: this.secureWebPreferences(),
    });
    win.removeMenu();
    this.harden(win);
    win.once("ready-to-show", () => win.show());
    win.on("closed", () => {
      this.chat = null;
    });
    this.load(win, "chat");
    this.chat = win;
    return win;
  }

  /** Next to Clawd (right side if there's room, else left), bottom-aligned with his feet, on his display. */
  private chatBoundsNearCompanion(size: Size): Rect {
    const c = this.companion && !this.companion.isDestroyed() ? this.companion.getBounds() : null;
    const body = c ? { x: c.x + this.layout.body.x, y: c.y + this.layout.body.y, width: this.layout.body.width, height: this.layout.body.height } : null;
    const area = body ? screen.getDisplayMatching(body).workArea : screen.getPrimaryDisplay().workArea;
    let x = area.x + Math.round((area.width - size.width) / 2);
    let y = area.y + Math.round((area.height - size.height) / 2);
    if (body && c) {
      // Beside the companion window (not just his body), so his speech bubble, which spans that
      // window's width, never covers the terminal.
      const gap = 6;
      x = c.x + c.width + gap + size.width <= area.x + area.width ? c.x + c.width + gap : c.x - gap - size.width;
      y = body.y + body.height - size.height;
    }
    x = Math.min(Math.max(x, area.x), area.x + area.width - size.width);
    y = Math.min(Math.max(y, area.y), area.y + area.height - size.height);
    return { x, y, ...size };
  }

  /** Title-bar buttons of the frameless chat window. */
  chatWindowControl(action: "minimize" | "close"): void {
    const win = this.chat;
    if (!win || win.isDestroyed()) return;
    if (action === "minimize") win.minimize();
    else win.close();
  }

  setChatAlwaysOnTop(on: boolean): void {
    if (this.chat && !this.chat.isDestroyed()) this.chat.setAlwaysOnTop(on);
  }

  sendChat(channel: string, payload: unknown): void {
    if (this.chat && !this.chat.isDestroyed()) this.chat.webContents.send(channel, payload);
  }

  openSettings(section?: string): BrowserWindow {
    if (this.settings && !this.settings.isDestroyed()) {
      if (this.settings.isMinimized()) this.settings.restore();
      this.settings.show();
      this.settings.focus();
      if (section) this.settings.webContents.send("settings:navigate", section);
      return this.settings;
    }
    const win = new BrowserWindow({
      width: 760,
      height: 640,
      minWidth: 560,
      minHeight: 460,
      title: "Settings — Clawd Buddy",
      show: false,
      autoHideMenuBar: true,
      backgroundColor: "#17140f",
      icon: this.paths.icon,
      webPreferences: this.secureWebPreferences(),
    });
    win.removeMenu();
    this.harden(win);
    win.once("ready-to-show", () => {
      win.show();
      if (section) win.webContents.send("settings:navigate", section);
    });
    win.on("closed", () => {
      this.settings = null;
    });
    this.load(win, "settings");
    this.settings = win;
    return win;
  }

  sendSettings(channel: string, payload: unknown): void {
    if (this.settings && !this.settings.isDestroyed()) this.settings.webContents.send(channel, payload);
  }

  destroyAll(): void {
    for (const w of [this.chat, this.settings, this.companion]) {
      if (w && !w.isDestroyed()) w.destroy();
    }
  }
}
