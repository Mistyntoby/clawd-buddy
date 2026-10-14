/**
 * Operating-system differences, kept in one place. Everything else in the app
 * is shared. Only things that genuinely differ between Windows and macOS (and,
 * for development, Linux) belong here.
 */
import { app, Menu, nativeImage, type BrowserWindow, type BrowserWindowConstructorOptions, type NativeImage } from "electron";
import { execFile } from "node:child_process";
import * as path from "node:path";

export interface PlatformAdapter {
  readonly id: NodeJS.Platform;
  /** One-time process setup, called when the app is ready. */
  onReady(): void;
  /** Extra options for the transparent companion window. */
  companionWindowOptions(): Partial<BrowserWindowConstructorOptions>;
  /** Keeps the companion above other windows (or not), at the right level for this OS. */
  setAlwaysOnTop(win: BrowserWindow, on: boolean): void;
  /** Tray / menu bar icon. */
  trayIcon(iconsDir: string): NativeImage;
  /** Whether a tray click should toggle the companion (Windows) or open the menu (macOS menu bar convention). */
  readonly trayClickToggles: boolean;
  /** Whether the tray can show a balloon tip (Windows only). */
  readonly trayBalloons: boolean;
  /** Whether "Launch at startup" can be offered. */
  launchAtStartupSupported(isPackaged: boolean): boolean;
  /** Folders to search for the Claude Code CLI in addition to PATH (GUI apps on macOS don't get the shell's PATH). */
  claudeCliDirs(home: string): string[];
  /** Possible locations of the Claude desktop app's resources archive. */
  claudeDesktopArchives(env: NodeJS.ProcessEnv): Promise<string[]>;
}

const windows: PlatformAdapter = {
  id: "win32",
  onReady() {
    // Groups taskbar entries and notifications under the app's identity.
    app.setAppUserModelId("io.github.clawdbuddy.app");
  },
  companionWindowOptions: () => ({ skipTaskbar: true }),
  setAlwaysOnTop(win, on) {
    win.setAlwaysOnTop(on, "screen-saver");
  },
  trayIcon(iconsDir) {
    return nativeImage.createFromPath(path.join(iconsDir, "tray.png"));
  },
  trayClickToggles: true,
  trayBalloons: true,
  launchAtStartupSupported: (isPackaged) => isPackaged,
  claudeCliDirs: (home) => [path.join(home, ".local", "bin")],
  async claudeDesktopArchives(env) {
    const out: string[] = [];
    // The Microsoft Store / MSIX install lives in WindowsApps, which usually can't be listed; ask Windows where it is.
    const location = await new Promise<string | null>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"],
        { timeout: 15_000, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout.trim() || null),
      );
    });
    if (location) out.push(path.join(location, "app", "resources", "app.asar"));
    if (env.LOCALAPPDATA) {
      out.push(path.join(env.LOCALAPPDATA, "AnthropicClaude", "resources", "app.asar"));
      out.push(path.join(env.LOCALAPPDATA, "Programs", "Claude", "resources", "app.asar"));
    }
    return out;
  },
};

const mac: PlatformAdapter = {
  id: "darwin",
  onReady() {
    // A desktop pet lives in the menu bar, not the Dock.
    app.dock?.hide();
    // Without an application menu, standard shortcuts (copy, paste, select all, quit) don't work in the chat window.
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]),
    );
  },
  companionWindowOptions: () => ({
    // Panels float above normal windows without stealing focus or showing in the Dock/Mission Control.
    type: "panel",
    hasShadow: false,
    roundedCorners: false,
    // macOS normally keeps a window's top edge below the menu bar. The companion window has a
    // transparent speech-bubble area above Clawd, so that would stop him from being dropped near
    // the top of the screen. For frameless windows this lets the app place the window exactly.
    enableLargerThanScreen: true,
  }),
  setAlwaysOnTop(win, on) {
    win.setAlwaysOnTop(on, "floating");
    // Stay with the user across Spaces and above full-screen apps' desktops.
    win.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on });
  },
  trayIcon(iconsDir) {
    const img = nativeImage.createFromPath(path.join(iconsDir, "trayTemplate.png"));
    if (!img.isEmpty()) {
      img.setTemplateImage(true);
      return img;
    }
    return nativeImage.createFromPath(path.join(iconsDir, "tray.png"));
  },
  trayClickToggles: false,
  trayBalloons: false,
  launchAtStartupSupported: (isPackaged) => isPackaged,
  claudeCliDirs: (home) => [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"],
  async claudeDesktopArchives() {
    return ["/Applications/Claude.app/Contents/Resources/app.asar", path.join(process.env.HOME ?? "", "Applications", "Claude.app", "Contents", "Resources", "app.asar")];
  },
};

/** Linux is only used for CI and development; it gets plain defaults. */
const linux: PlatformAdapter = {
  id: "linux",
  onReady() {},
  companionWindowOptions: () => ({ skipTaskbar: true }),
  setAlwaysOnTop(win, on) {
    win.setAlwaysOnTop(on);
  },
  trayIcon(iconsDir) {
    return nativeImage.createFromPath(path.join(iconsDir, "tray.png"));
  },
  trayClickToggles: true,
  trayBalloons: false,
  launchAtStartupSupported: () => false,
  claudeCliDirs: (home) => [path.join(home, ".local", "bin")],
  async claudeDesktopArchives() {
    return [];
  },
};

export function platformAdapter(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  if (platform === "win32") return windows;
  if (platform === "darwin") return mac;
  return linux;
}
