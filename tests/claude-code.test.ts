import { describe, expect, it } from "vitest";
import { toFriendlyError } from "../src/main/chat-errors";
import {
  buildCliArgs,
  buildCliPrompt,
  ClaudeCodeError,
  cliEnv,
  cliResultError,
  findClaudeCli,
  parseCliLine,
} from "../src/main/claude-code-client";
import { validateSettingsPatch } from "../src/shared/settings-schema";

describe("finding the Claude Code CLI", () => {
  const files = new Set(["C:\\Tools\\claude.exe", "C:\\Home\\.local\\bin\\claude.exe", "/usr/local/bin/claude"]);
  const isFile = (p: string) => files.has(p);

  it("searches PATH first on Windows", () => {
    expect(findClaudeCli({ env: { Path: "C:\\Windows;C:\\Tools" }, platform: "win32", home: "C:\\Home", isFile })).toBe("C:\\Tools\\claude.exe");
  });

  it("falls back to the default install folder", () => {
    expect(findClaudeCli({ env: { PATH: "C:\\Windows" }, platform: "win32", home: "C:\\Home", isFile })).toBe("C:\\Home\\.local\\bin\\claude.exe");
  });

  it("ignores relative PATH entries and npm's .cmd shim", () => {
    const shimOnly = new Set(["C:\\npm\\claude.cmd", "tools\\claude.exe"]);
    expect(findClaudeCli({ env: { PATH: "tools;C:\\npm" }, platform: "win32", home: "C:\\Nobody", isFile: (p) => shimOnly.has(p) })).toBeNull();
  });

  it("works on POSIX paths", () => {
    expect(findClaudeCli({ env: { PATH: "/usr/bin:/usr/local/bin" }, platform: "linux", home: "/home/u", isFile })).toBe("/usr/local/bin/claude");
  });
});

describe("running the CLI", () => {
  it("removes API-key variables so the subscription sign-in is used", () => {
    const env = cliEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDECODE: "1", PATH: "x" });
    expect(env).toEqual({ PATH: "x" });
  });

  it("disables tools, plugins, and session history", () => {
    const args = buildCliArgs("claude-opus-5-5", "Be nice.");
    expect(args).toContain("-p");
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("Be nice.");
  });

  it("sends a single message as-is and earlier turns as a transcript", () => {
    expect(buildCliPrompt([{ role: "user", content: "hi" }])).toBe("hi");
    const prompt = buildCliPrompt([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "and now?" },
    ]);
    expect(prompt).toContain("<user>\nhi\n</user>\n<you>\nHello!\n</you>");
    expect(prompt.endsWith("<latest_message>\nand now?\n</latest_message>")).toBe(true);
    expect(buildCliPrompt([])).toBe("");
  });
});

describe("parsing CLI output", () => {
  it("extracts text deltas from the main conversation only", () => {
    const delta = (parent: string | null) =>
      JSON.stringify({ type: "stream_event", parent_tool_use_id: parent, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } });
    expect(parseCliLine(delta(null))).toEqual({ type: "delta", text: "Hi" });
    expect(parseCliLine(delta("toolu_1"))).toBeNull();
  });

  it("reads the final result", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", stop_reason: null });
    expect(parseCliLine(line)).toEqual({ type: "result", isError: true, text: "Not logged in · Please run /login", stopReason: null, status: null });
    expect(parseCliLine(JSON.stringify({ type: "result", is_error: false, result: "ok", stop_reason: "end_turn", api_error_status: 404 }))).toMatchObject({
      stopReason: "end_turn",
      status: 404,
    });
  });

  it("ignores other events and junk", () => {
    expect(parseCliLine(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull();
    expect(parseCliLine("[claude-code:warning] something")).toBeNull();
    expect(parseCliLine("null")).toBeNull();
  });
});

describe("CLI errors", () => {
  it("maps known failures to friendly messages", () => {
    expect(cliResultError("Not logged in · Please run /login", null).kind).toBe("auth");
    expect(cliResultError("There's an issue with the selected model (x).", 404).kind).toBe("not_found");
    expect(cliResultError("Claude usage limit reached", null).kind).toBe("rate_limit");
    expect(cliResultError("", 529).kind).toBe("overloaded");
  });

  it("shows a short excerpt of anything else", () => {
    const e = cliResultError(`weird\n${"x".repeat(500)}`, null);
    expect(e.kind).toBe("unknown");
    expect(e.message.length).toBeLessThan(260);
    expect(e.message).toContain("weird x");
  });

  it("passes through toFriendlyError unchanged", () => {
    expect(toFriendlyError(new ClaudeCodeError("auth", "Sign in."))).toEqual({ kind: "auth", message: "Sign in." });
  });
});

describe("provider setting", () => {
  it("accepts only known providers", () => {
    expect(validateSettingsPatch({ aiProvider: "claude-code" })).toEqual({ ok: true, patch: { aiProvider: "claude-code" } });
    expect(validateSettingsPatch({ aiProvider: "openai" }).ok).toBe(false);
  });
});
