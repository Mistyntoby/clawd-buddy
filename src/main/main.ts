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
  // corsEnabled lets the companion read sprite pixels for click-through hit testing (an untainted canvas).
  { scheme: ASSET_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  // Another Clawd is already running; it will show itself (see "second-instance").
  app.quit();
} else {
  let clawd: ClawdApp | null = null;

  app.on("second-instance", () => clawd?.showCompanion());

  app.whenReady().then(() => {
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

    protocol.handle(ASSET_PROTOCOL, async (request) => {
      const file = resolveAssetRequest(request.url, instance.assets.registry);
      if (!file) return new Response("Not found", { status: 404 });
      const res = await net.fetch(pathToFileURL(file).href);
      // Sprites are plain, validated images; allowing CORS reads keeps the canvas readable for hit testing.
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(res.body, { status: res.status, headers });
    });

    registerIpc(instance, path.join(distDir, "renderer"));
    instance.start();

    if (smokeDir) void runSmokeTest(instance, smokeDir);
  });

  // macOS: clicking the app again (Finder, Launchpad, Spotlight) brings Clawd back.
  app.on("activate", () => clawd?.showCompanion());

  // Clawd lives in the tray / menu bar: closing windows does not quit the app.
  app.on("window-all-closed", () => {
    /* keep running */
  });

  app.on("before-quit", () => clawd?.shutdown());
}
