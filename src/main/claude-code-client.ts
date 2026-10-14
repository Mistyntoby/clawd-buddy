import type Anthropic from "@anthropic-ai/sdk";
import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DEFAULT_EFFORT } from "../shared/constants";
import type { ChatErrorKind } from "../shared/types";
import type { ChatStream, StreamFactory } from "./claude-client";

/**
 * Backend that answers through the user's locally installed Claude Code CLI
 * ("claude -p"), so replies are covered by the Claude subscription that CLI is
 * signed in with. The app never reads, copies, or stores Claude Code's
 * credentials: it only starts the official executable and reads its output.
 */

/** No reply at all for this long means something is stuck. */
const CLI_TIMEOUT_MS = 180_000;
const STDERR_KEEP_CHARS = 4000;

export class ClaudeCodeError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeCodeError";
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface CliLookup {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  home: string;
  isFile: (p: string) => boolean;
}

/**
 * Finds the Claude Code executable on PATH or in its default install folder.
 * On Windows only the native claude.exe is accepted: npm's claude.cmd shim
 * would need a shell to run, and the app never spawns through a shell.
 */
export function findClaudeCli(
  lookup: CliLookup = { env: process.env, platform: process.platform, home: homedir(), isFile },
): string | null {
  const win = lookup.platform === "win32";
  const pathImpl = win ? path.win32 : path.posix;
  const exe = win ? "claude.exe" : "claude";
  const pathVar = lookup.env.PATH ?? lookup.env.Path ?? "";
  const dirs = pathVar.split(win ? ";" : ":").filter((d) => d.trim().length > 0 && pathImpl.isAbsolute(d));
  dirs.push(pathImpl.join(lookup.home, ".local", "bin"));
  for (const dir of dirs) {
    const candidate = pathImpl.join(dir.replace(/^"|"$/g, ""), exe);
    if (lookup.isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Environment for the CLI. API-key variables are removed so the CLI uses its
 * own subscription sign-in instead of silently billing an API account, and the
 * nested-session marker is removed in case the app was launched from Claude Code.
 */
export function cliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"]) delete out[key];
  return out;
}

/**
 * Arguments for a plain, tool-less chat turn: no tools, MCP servers, hooks,
 * plugins, CLAUDE.md files, or slash commands, and nothing saved to the
 * CLI's session history.
 */
export function buildCliArgs(model: string, system: string): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--safe-mode",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--model",
    model,
    "--effort",
    DEFAULT_EFFORT,
    "--system-prompt",
    system,
  ];
}

function contentText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/**
 * The CLI takes one prompt per run, so earlier turns are included as a
 * transcript ahead of the newest message.
 */
export function buildCliPrompt(messages: readonly Anthropic.MessageParam[]): string {
  const last = messages.at(-1);
  if (!last) return "";
  const latest = contentText(last.content);
  if (messages.length === 1) return latest;
  const earlier = messages
    .slice(0, -1)
    .map((m) => (m.role === "user" ? `<user>\n${contentText(m.content)}\n</user>` : `<you>\n${contentText(m.content)}\n</you>`))
    .join("\n");
  return [
    "Our conversation so far:",
    "<conversation>",
    earlier,
    "</conversation>",
    "",
    "Reply to the user's newest message:",
    "<latest_message>",
    latest,
    "</latest_message>",
  ].join("\n");
}

export type CliEvent =
  | { type: "delta"; text: string }
  | { type: "result"; isError: boolean; text: string; stopReason: string | null; status: number | null };

/** Parses one line of `--output-format stream-json`. Unrelated or malformed lines return null. */
export function parseCliLine(line: string): CliEvent | null {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.type === "stream_event" && o.parent_tool_use_id == null) {
    const ev = o.event as { type?: string; delta?: { type?: string; text?: unknown } } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
      return { type: "delta", text: ev.delta.text };
    }
    return null;
  }
  if (o.type === "result") {
    return {
      type: "result",
      isError: o.is_error === true,
      text: typeof o.result === "string" ? o.result : "",
      stopReason: typeof o.stop_reason === "string" ? o.stop_reason : null,
      status: typeof o.api_error_status === "number" ? o.api_error_status : null,
    };
  }
  return null;
}

/** Turns a failed CLI result into a short, user-facing error. */
export function cliResultError(text: string, status: number | null): ClaudeCodeError {
  if (status === 401 || /not logged in|\/login|authenticat|oauth token/i.test(text)) {
    return new ClaudeCodeError("auth", "Claude Code isn't signed in. Open a terminal, run `claude`, sign in with your Claude account, then try again.");
  }
  if (status === 404 || /issue with the selected model|model.*(not exist|not found)/i.test(text)) {
    return new ClaudeCodeError("not_found", "Your Claude plan can't use that model, or the name is wrong. Pick another model in Settings → AI.");
  }
  if (status === 429 || /usage limit|rate limit|limit reached|out of (extra )?usage/i.test(text)) {
    return new ClaudeCodeError("rate_limit", "You've hit your Claude plan's usage limit for now. Try again after it resets.");
  }
  if (status === 529 || /overloaded/i.test(text)) {
    return new ClaudeCodeError("overloaded", "Claude is overloaded at the moment. Please try again shortly.");
  }
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
  return new ClaudeCodeError("unknown", detail ? `Claude Code reported a problem: ${detail}` : "Claude Code reported a problem. Please try again.");
}

export const claudeCodeStreamFactory: StreamFactory = (req) => {
  if (req.connection.provider !== "claude-code") throw new Error("claudeCodeStreamFactory needs a Claude Code connection.");
  const child = spawn(req.connection.cliPath, buildCliArgs(req.model, req.system), {
    cwd: req.connection.workDir,
    env: cliEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });

  // Queue between the process callbacks and the async iterator.
  const queue: string[] = [];
  let waiters: (() => void)[] = [];
  let ended = false;
  let failure: unknown = null;
  let aborted = false;
  let streamed = "";
  let result: Extract<CliEvent, { type: "result" }> | null = null;
  let stderr = "";

  const notify = () => {
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  };
  const waitForChange = () => new Promise<void>((resolve) => waiters.push(resolve));
  const finish = (err?: unknown) => {
    if (ended) return;
    ended = true;
    if (err !== undefined) failure = err;
    clearTimeout(timer);
    notify();
  };

  const timer = setTimeout(() => {
    child.kill();
    finish(new ClaudeCodeError("network", "Claude Code took too long to answer. Check your connection and try again."));
  }, CLI_TIMEOUT_MS);

  createInterface({ input: child.stdout }).on("line", (line) => {
    const ev = parseCliLine(line);
    if (ev?.type === "delta") {
      streamed += ev.text;
      queue.push(ev.text);
      notify();
    } else if (ev?.type === "result") {
      result = ev;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_KEEP_CHARS) stderr += chunk.toString("utf8");
  });
  child.on("error", (err: NodeJS.ErrnoException) => {
    finish(
      err.code === "ENOENT"
        ? new ClaudeCodeError("not_found", "Claude Code wasn't found. Install it, or switch to an API key in Settings → AI.")
        : new ClaudeCodeError("unknown", "Claude Code couldn't be started."),
    );
  });
  child.on("close", (code) => {
    const r = result as Extract<CliEvent, { type: "result" }> | null;
    if (aborted) finish(abortError());
    else if (r?.isError) finish(cliResultError(r.text, r.status));
    else if (r) finish();
    else {
      // Only the exit code is logged; stderr may echo the prompt.
      console.warn(`[claude-code] exited with code ${String(code)} without a result`);
      finish(cliResultError(stderr, null));
    }
  });
  child.stdin.on("error", () => {
    // The process may exit before reading stdin; "close" reports the outcome.
  });
  child.stdin.end(buildCliPrompt(req.messages), "utf8");

  async function* deltas(): AsyncGenerator<string> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (ended) break;
      await waitForChange();
    }
    if (failure) throw failure;
  }

  return {
    textDeltas: deltas(),
    async final() {
      while (!ended) await waitForChange();
      if (failure) throw failure;
      const r = result as Extract<CliEvent, { type: "result" }> | null;
      return { stopReason: r?.stopReason ?? null, text: (r?.text || streamed).trim() };
    },
    abort() {
      aborted = true;
      child.kill();
      finish(abortError());
    },
  } satisfies ChatStream;
};

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

export interface ClaudeCodeAuth {
  loggedIn: boolean;
  authMethod: string;
  subscriptionType: string | null;
}

/**
 * Asks the CLI whether it is signed in (`claude auth status`). This costs no
 * usage. Only the sign-in state, method, and plan are read; account details
 * in the output are ignored.
 */
export function checkClaudeCode(cliPath: string): Promise<ClaudeCodeAuth> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, ["auth", "status"], { env: cliEnv(), timeout: 30_000, windowsHide: true }, (err, stdout) => {
      try {
        const o = JSON.parse(stdout) as Record<string, unknown>;
        resolve({
          loggedIn: o.loggedIn === true,
          authMethod: typeof o.authMethod === "string" ? o.authMethod : "unknown",
          subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
        });
      } catch {
        reject(
          (err as NodeJS.ErrnoException | null)?.code === "ENOENT"
            ? new ClaudeCodeError("not_found", "Claude Code wasn't found.")
            : new ClaudeCodeError("unknown", "Couldn't read Claude Code's sign-in status. Try updating Claude Code."),
        );
      }
    });
  });
}
