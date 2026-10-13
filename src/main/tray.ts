import { Menu, nativeImage, Tray } from "electron";
import * as path from "node:path";
import type { ClawdApp } from "./clawd-app";

/**
 * System tray icon: the always-available way to show Clawd again, open chat
 * or settings, and quit.
 */
export class TrayController {
  private tray: Tray | null = null;
  private hiddenNoticeShown = false;

  constructor(
    private readonly app: ClawdApp,
    private readonly iconDir: string,
  ) {}

  create(): void {
    const image = nativeImage.createFromPath(path.join(this.iconDir, "tray.png"));
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.tray.setToolTip("Clawd Buddy");
    this.tray.on("click", () => this.app.toggleCompanion());
    this.tray.on("double-click", () => this.app.showCompanion());
    this.refresh();
  }

  refresh(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const s = this.app.settings.get();
    const visible = this.app.windows.isVisible();
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: visible ? `Hide ${s.companionName}` : `Show ${s.companionName}`, click: () => this.app.toggleCompanion() },
        { label: "Open chat", click: () => this.app.openChat() },
        { label: "Settings…", click: () => this.app.windows.openSettings() },
        { type: "separator" },
        { label: "Wander around", type: "checkbox", checked: s.wandering, click: (i) => this.app.settings.update({ wandering: i.checked }) },
        { label: "Sounds", type: "checkbox", checked: s.soundEnabled, click: (i) => this.app.settings.update({ soundEnabled: i.checked }) },
        { type: "separator" },
        { label: "Quit Clawd Buddy", click: () => this.app.quit() },
      ]),
    );
  }

  /** One-time hint so users know how to bring the companion back. */
  notifyHidden(): void {
    if (this.hiddenNoticeShown || !this.tray || process.platform !== "win32") return;
    this.hiddenNoticeShown = true;
    try {
      this.tray.displayBalloon({
        title: "Clawd is hiding",
        content: "Click the Clawd Buddy tray icon to bring them back.",
        iconType: "info",
        noSound: true,
      });
    } catch {
      /* balloons are best-effort */
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
