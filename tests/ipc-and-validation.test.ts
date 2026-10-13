import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_POLICY, isAllowed, isTrustedSenderUrl } from "../src/shared/ipc-policy";
import {
  extractRememberRequest,
  maskApiKey,
  validateApiKeyFormat,
  validateChatMessage,
  validateCommand,
  validateId,
  validatePoint,
} from "../src/shared/validation";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", "src", p), "utf8");

describe("IPC policy", () => {
  it("only allows each window its own channels", () => {
    expect(isAllowed("chat:send", "chat")).toBe(true);
    expect(isAllowed("chat:send", "companion")).toBe(false);
    expect(isAllowed("ai:set-key", "chat")).toBe(false);
    expect(isAllowed("ai:set-key", "companion")).toBe(false);
    expect(isAllowed("ai:set-key", "settings")).toBe(true);
    expect(isAllowed("app:quit", "companion")).toBe(false);
  });

  it("rejects unknown channels and unknown senders", () => {
    expect(isAllowed("shell:exec", "settings")).toBe(false);
    expect(isAllowed("__proto__", "settings")).toBe(false);
    expect(isAllowed("toString", "settings")).toBe(false);
    expect(isAllowed("chat:send", null)).toBe(false);
  });

  it("covers every channel the preload uses, and the main process registers every policy channel", () => {
    const preload = src("preload/preload.ts");
    const ipc = src("main/ipc.ts");
    const sent = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(20);
    for (const ch of sent) expect(Object.keys(IPC_POLICY)).toContain(ch);
    const registered = [...ipc.matchAll(/(?:handle|listen)\("([^"]+)"/g)].map((m) => m[1]);
    for (const ch of Object.keys(IPC_POLICY)) expect(registered).toContain(ch);
  });

  it("never exposes raw ipcRenderer or Node APIs through the bridge", () => {
    const preload = src("preload/preload.ts");
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer/);
    expect(preload).not.toMatch(/require\(/);
    expect(preload).not.toMatch(/\bfs\b|child_process|shell\./);
  });

  it("trusts only pages under the bundled renderer directory", () => {
    const root = "file:///C:/app/dist/renderer";
    expect(isTrustedSenderUrl("file:///C:/app/dist/renderer/chat/index.html", root)).toBe(true);
    expect(isTrustedSenderUrl("file:///C:/app/dist/renderer-evil/x.html", root)).toBe(false);
    expect(isTrustedSenderUrl("https://example.com/", root)).toBe(false);
    expect(isTrustedSenderUrl(undefined, root)).toBe(false);
  });

  it("windows are created with isolation and sandboxing", () => {
    const wm = src("main/window-manager.ts");
    expect(wm).toMatch(/contextIsolation: true/);
    expect(wm).toMatch(/nodeIntegration: false/);
    expect(wm).toMatch(/sandbox: true/);
  });
});

describe("input validation", () => {
  it("API key format", () => {
    expect(validateApiKeyFormat("sk-ant-api03-abcdefghijklmnopqrstuv").ok).toBe(true);
    expect(validateApiKeyFormat("  sk-ant-api03-abcdefghijklmnopqrstuv \n")).toEqual({ ok: true, value: "sk-ant-api03-abcdefghijklmnopqrstuv" });
    expect(validateApiKeyFormat("").ok).toBe(false);
    expect(validateApiKeyFormat("sk-openai-123456789012345678901234").ok).toBe(false);
    expect(validateApiKeyFormat("sk-ant-api03 abc defghijklmnopqrstuvwxyz").ok).toBe(false);
    expect(validateApiKeyFormat("sk-ant-short").ok).toBe(false);
    expect(validateApiKeyFormat({}).ok).toBe(false);
  });

  it("masks keys for display", () => {
    const masked = maskApiKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(masked).toBe("sk-ant-…wxyz");
    expect(maskApiKey("short")).toBe("••••");
  });

  it("chat messages", () => {
    expect(validateChatMessage("  hi  ")).toEqual({ ok: true, value: "hi" });
    expect(validateChatMessage("").ok).toBe(false);
    expect(validateChatMessage("x".repeat(4001)).ok).toBe(false);
    expect(validateChatMessage(5).ok).toBe(false);
  });

  it("points, ids and commands", () => {
    expect(validatePoint({ x: 1.6, y: -2 })).toEqual({ ok: true, value: { x: 2, y: -2 } });
    expect(validatePoint({ x: Infinity, y: 0 }).ok).toBe(false);
    expect(validatePoint({ x: "1", y: 0 }).ok).toBe(false);
    expect(validateId("abc_123").ok).toBe(true);
    expect(validateId("../x").ok).toBe(false);
    expect(validateCommand("poke").ok).toBe(true);
    expect(validateCommand("rm -rf").ok).toBe(false);
  });

  it("detects explicit remember requests only", () => {
    expect(extractRememberRequest("remember that I like tea")).toBe("I like tea");
    expect(extractRememberRequest("/remember my cat is Miso")).toBe("my cat is Miso");
    expect(extractRememberRequest("Remember: standup at 10")).toBe("standup at 10");
    expect(extractRememberRequest("do you remember me?")).toBeNull();
    expect(extractRememberRequest("remember")).toBeNull();
  });
});
