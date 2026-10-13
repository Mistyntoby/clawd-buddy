import { app, net, protocol, session } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { ASSET_PROTOCOL } from "../shared/constants";
import { resolveAssetRequest } from "./asset-provider";
import { ClawdApp } from "./clawd-app";
import { registerIpc } from "./ipc";
import { runSmokeTest } from "./smoke";

/**
 * Entry point. Responsibilities: single-instance lock, security defaults,
 * the sprite asset protocol, and app lifecycle.
 */

const smokeDir = process.env.CLAWD_SMOKE_DIR;
if (smokeDir) {
  // Isolated profile for automated runtime checks; never touches real user data.
  app.setPath("userData", path.resolve(smokeDir, "userData"));
}

// The sprite protocol must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  // Another Clawd is already running; it will show itself (see "second-instance").
  app.quit();
} else {
  let clawd: ClawdApp | null = null;

  app.on("second-instance", () => clawd?.showCompanion());

  app.whenReady().then(() => {
    // Windows uses this to group notifications/taskbar entries.
    app.setAppUserModelId("io.github.clawdbuddy.app");

    const appRoot = app.getAppPath();
    const distDir = path.join(appRoot, "dist");
    const resources = app.isPackaged ? process.resourcesPath : path.join(appRoot, "assets");
    clawd = new ClawdApp({
      userData: app.getPath("userData"),
      resources,
      distDir,
      devLocalSprites: app.isPackaged ? null : path.join(appRoot, "assets", "sprites", "local"),
    });
    const instance = clawd;

    // Deny every permission request (camera, mic, notifications, …); the app needs none.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    protocol.handle(ASSET_PROTOCOL, (request) => {
      const file = resolveAssetRequest(request.url, instance.assets.registry);
      if (!file) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    });

    registerIpc(instance, path.join(distDir, "renderer"));
    instance.start();

    if (smokeDir) void runSmokeTest(instance, smokeDir);
  });

  // Clawd lives in the tray: closing windows does not quit the app.
  app.on("window-all-closed", () => {
    /* keep running */
  });

  app.on("before-quit", () => clawd?.shutdown());
}
