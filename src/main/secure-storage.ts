import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJsonAtomic } from "./settings";

/**
 * Minimal interface over Electron's safeStorage (DPAPI on Windows, Keychain on
 * macOS). Injected so the store can be tested without Electron.
 */
export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type KeySource = "saved" | "environment" | "session" | "none";

/**
 * Holds the Anthropic API key in the main process only. The key is never sent
 * to a renderer and never logged. When OS encryption is unavailable the key is
 * kept for the current session only — it is never written to disk in plain text.
 */
export class SecretStore {
  private readonly file: string;
  private sessionKey: string | null = null;
  private cachedSaved: string | null | undefined;

  constructor(
    dir: string,
    private readonly encryptor: Encryptor,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.file = path.join(dir, "secrets.json");
  }

  get encryptionAvailable(): boolean {
    try {
      return this.encryptor.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Stores the key. Returns where it ended up. */
  setApiKey(key: string, persist: boolean): "saved" | "session" {
    this.sessionKey = null;
    this.cachedSaved = undefined;
    if (persist && this.encryptionAvailable) {
      const encrypted = this.encryptor.encryptString(key).toString("base64");
      writeJsonAtomic(this.file, { anthropicApiKey: encrypted });
      this.cachedSaved = key;
      return "saved";
    }
    this.deleteFile();
    this.sessionKey = key;
    return "session";
  }

  clearApiKey(): void {
    this.sessionKey = null;
    this.cachedSaved = null;
    this.deleteFile();
  }

  getApiKey(): { key: string | null; source: KeySource } {
    if (this.sessionKey) return { key: this.sessionKey, source: "session" };
    const saved = this.readSaved();
    if (saved) return { key: saved, source: "saved" };
    const envKey = this.env.ANTHROPIC_API_KEY?.trim();
    if (envKey) return { key: envKey, source: "environment" };
    return { key: null, source: "none" };
  }

  private readSaved(): string | null {
    if (this.cachedSaved !== undefined) return this.cachedSaved;
    const raw = readJson(this.file) as { anthropicApiKey?: unknown } | undefined;
    let key: string | null = null;
    if (raw && typeof raw.anthropicApiKey === "string" && this.encryptionAvailable) {
      try {
        key = this.encryptor.decryptString(Buffer.from(raw.anthropicApiKey, "base64"));
      } catch {
        console.warn("[secrets] Saved API key could not be decrypted; please enter it again.");
      }
    }
    this.cachedSaved = key;
    return key;
  }

  private deleteFile(): void {
    try {
      fs.rmSync(this.file, { force: true });
    } catch {
      console.warn("[secrets] Could not remove the saved key file.");
    }
  }
}
