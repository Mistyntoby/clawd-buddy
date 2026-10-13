// Builds main, preload, and renderer bundles into dist/ with esbuild.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const production = process.env.NODE_ENV === "production";

rmSync(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  sourcemap: production ? false : "linked",
  minify: production,
  logLevel: "warning",
  target: "es2023",
};

// Main process: Node/CommonJS, Electron provided at runtime.
await build({
  ...common,
  entryPoints: [join(root, "src/main/main.ts")],
  outfile: join(dist, "main/main.js"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

// Preload: runs in the sandbox, so it must be a single CommonJS file that only requires "electron".
await build({
  ...common,
  entryPoints: [join(root, "src/preload/preload.ts")],
  outfile: join(dist, "preload/preload.js"),
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

// Renderers: plain browser scripts.
for (const page of ["companion", "chat", "settings"]) {
  await build({
    ...common,
    entryPoints: [join(root, `src/renderer/${page}/main.ts`)],
    outfile: join(dist, `renderer/${page}/main.js`),
    platform: "browser",
    format: "iife",
  });
  const out = join(dist, "renderer", page);
  mkdirSync(out, { recursive: true });
  cpSync(join(root, `src/renderer/${page}`), out, {
    recursive: true,
    filter: (src) => !src.endsWith(".ts"),
  });
}
cpSync(join(root, "src/renderer/styles"), join(dist, "renderer/styles"), { recursive: true });

console.info("Build complete → dist/");
