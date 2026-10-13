// Launches the built app in smoke-test mode against a throwaway profile and
// reports the results. Screenshots land in smoke-output/ (git-ignored).
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "smoke-output");
rmSync(out, { recursive: true, force: true });

const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, ["."], {
  cwd: root,
  env: { ...process.env, CLAWD_SMOKE_DIR: out, ANTHROPIC_API_KEY: "" },
  stdio: "inherit",
});

const timeout = setTimeout(() => {
  console.error("Smoke test timed out.");
  child.kill();
  process.exit(1);
}, 90_000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  try {
    const results = JSON.parse(readFileSync(join(out, "results.json"), "utf8"));
    const failed = results.checks.filter((c) => !c.ok).length;
    console.info(`\nSmoke test: ${results.checks.length - failed}/${results.checks.length} checks passed.`);
  } catch {
    console.error("No smoke results were written.");
  }
  process.exit(code ?? 1);
});
