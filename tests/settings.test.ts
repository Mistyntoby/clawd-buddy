import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretStore, type Encryptor } from "../src/main/secure-storage";
import { MemoryStore, SettingsStore } from "../src/main/settings";
import { DEFAULT_SETTINGS, sanitizeSettings, validateSettingsPatch } from "../src/shared/settings-schema";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-settings-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("settings persistence", () => {
  it("uses safe defaults on first run", () => {
    const s = new SettingsStore(dir).get();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.launchAtStartup).toBe(false);
    expect(s.aiEnabled).toBe(false);
    expect(s.memoryEnabled).toBe(false);
  });

  it("persists changes across restarts", () => {
    const a = new SettingsStore(dir);
    a.update({ wandering: false, movementSpeed: "fast", position: { x: 10, y: 20 } });
    a.flush();
    const b = new SettingsStore(dir).get();
    expect(b.wandering).toBe(false);
    expect(b.movementSpeed).toBe("fast");
    expect(b.position).toEqual({ x: 10, y: 20 });
  });

  it("recovers from a corrupt settings file", () => {
    fs.writeFileSync(path.join(dir, "settings.json"), "{{{ garbage");
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid fields and drops invalid ones from disk", () => {
    const s = sanitizeSettings({ wandering: false, characterScale: 99, movementSpeed: "warp", bogus: 1 });
    expect(s.wandering).toBe(false);
    expect(s.characterScale).toBe(DEFAULT_SETTINGS.characterScale);
    expect(s.movementSpeed).toBe(DEFAULT_SETTINGS.movementSpeed);
    expect("bogus" in s).toBe(false);
  });

  it("reports which keys changed and notifies listeners", () => {
    const store = new SettingsStore(dir);
    const seen: string[][] = [];
    store.onChange((_s, changed) => seen.push(changed));
    expect(store.update({ wandering: true })).toEqual([]); // unchanged
    expect(store.update({ wandering: false, soundEnabled: true })).toEqual(["wandering"]);
    expect(seen).toEqual([["wandering"]]);
  });

  it("reset restores defaults but keeps first-run state", () => {
    const store = new SettingsStore(dir);
    store.update({ firstRunComplete: true, wandering: false });
    store.reset();
    expect(store.get().wandering).toBe(true);
    expect(store.get().firstRunComplete).toBe(true);
  });
});

describe("settings patch validation (IPC input)", () => {
  it("accepts valid patches", () => {
    const r = validateSettingsPatch({ movementSpeed: "slow", characterScale: 4, companionName: "  Pip  " });
    expect(r).toEqual({ ok: true, patch: { movementSpeed: "slow", characterScale: 4, companionName: "Pip" } });
  });
  it("rejects unknown keys, wrong types, and protected fields", () => {
    expect(validateSettingsPatch({ evil: true }).ok).toBe(false);
    expect(validateSettingsPatch({ wandering: "yes" }).ok).toBe(false);
    expect(validateSettingsPatch({ characterScale: 2.5 }).ok).toBe(false);
    expect(validateSettingsPatch({ model: "../../etc" }).ok).toBe(false);
    expect(validateSettingsPatch({ version: 2 }).ok).toBe(false);
    expect(validateSettingsPatch({ companionName: "   " }).ok).toBe(false);
    expect(validateSettingsPatch(null).ok).toBe(false);
    expect(validateSettingsPatch([1]).ok).toBe(false);
  });
});

describe("memory store", () => {
  it("adds, edits, deletes, and persists approved items", () => {
    const m = new MemoryStore(dir);
    const r = m.add("I like short answers");
    expect(r.ok).toBe(true);
    const id = r.ok ? r.item.id : "";
    expect(m.edit(id, "I like very short answers").ok).toBe(true);
    expect(new MemoryStore(dir).list().map((i) => i.text)).toEqual(["I like very short answers"]);
    expect(m.remove(id)).toBe(true);
    expect(m.remove(id)).toBe(false);
    expect(new MemoryStore(dir).list()).toEqual([]);
  });
  it("rejects empty or oversized items", () => {
    const m = new MemoryStore(dir);
    expect(m.add("   ").ok).toBe(false);
    expect(m.add("x".repeat(301)).ok).toBe(false);
    expect(m.add(42).ok).toBe(false);
  });
  it("ignores malformed entries on disk", () => {
    fs.writeFileSync(path.join(dir, "memory.json"), JSON.stringify([{ id: "a", text: "ok", createdAt: "x" }, { nope: 1 }, "str"]));
    expect(new MemoryStore(dir).list()).toHaveLength(1);
  });
});

describe("secret store", () => {
  const fakeEncryptor = (available = true): Encryptor => ({
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join("")}`),
    decryptString: (b) => [...b.toString().slice(4)].reverse().join(""),
  });
  const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

  it("saves the key encrypted, never in plain text", () => {
    const s = new SecretStore(dir, fakeEncryptor(), {});
    expect(s.setApiKey(KEY, true)).toBe("saved");
    const onDisk = fs.readFileSync(path.join(dir, "secrets.json"), "utf8");
    expect(onDisk).not.toContain(KEY);
    expect(new SecretStore(dir, fakeEncryptor(), {}).getApiKey()).toEqual({ key: KEY, source: "saved" });
  });

  it("keeps the key in memory only when encryption is unavailable", () => {
    const s = new SecretStore(dir, fakeEncryptor(false), {});
    expect(s.setApiKey(KEY, true)).toBe("session");
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(false);
    expect(s.getApiKey().source).toBe("session");
    expect(new SecretStore(dir, fakeEncryptor(false), {}).getApiKey().key).toBeNull();
  });

  it("falls back to the environment variable and can be cleared", () => {
    const s = new SecretStore(dir, fakeEncryptor(), { ANTHROPIC_API_KEY: KEY });
    expect(s.getApiKey()).toEqual({ key: KEY, source: "environment" });
    s.setApiKey("sk-ant-api03-other-key-value-123456", true);
    expect(s.getApiKey().source).toBe("saved");
    s.clearApiKey();
    expect(fs.existsSync(path.join(dir, "secrets.json"))).toBe(false);
    expect(s.getApiKey().source).toBe("environment");
  });

  it("survives an undecryptable saved key", () => {
    fs.writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ anthropicApiKey: "zzz" }));
    const broken: Encryptor = { ...fakeEncryptor(), decryptString: () => { throw new Error("bad"); } };
    expect(new SecretStore(dir, broken, {}).getApiKey()).toEqual({ key: null, source: "none" });
  });
});
