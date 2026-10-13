import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_MEMORY_ITEMS } from "../shared/constants";
import { DEFAULT_SETTINGS, sanitizeSettings, type SettingsPatch } from "../shared/settings-schema";
import type { MemoryItem, Settings } from "../shared/types";
import { validateMemoryText } from "../shared/validation";

/**
 * Writes JSON atomically: write a temp file next to the target, then rename.
 * A crash mid-write therefore never leaves a half-written settings file.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.warn(`[settings] Could not read ${path.basename(file)}; using defaults.`);
    return undefined;
  }
}

type Listener = (settings: Settings, changed: (keyof Settings)[]) => void;

export class SettingsStore {
  private settings: Settings;
  private readonly file: string;
  private readonly listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string, private readonly saveDelayMs = 400) {
    this.file = path.join(dir, "settings.json");
    this.settings = sanitizeSettings(readJson(this.file));
  }

  get(): Settings {
    return { ...this.settings };
  }

  /** Applies an already-validated patch. Returns the keys that actually changed. */
  update(patch: SettingsPatch): (keyof Settings)[] {
    const changed: (keyof Settings)[] = [];
    const next = { ...this.settings } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(value)) {
        next[key] = value;
        changed.push(key as keyof Settings);
      }
    }
    if (changed.length === 0) return changed;
    this.settings = next as unknown as Settings;
    this.scheduleSave();
    for (const l of this.listeners) l(this.get(), changed);
    return changed;
  }

  reset(): void {
    // Keep first-run state so the welcome flow does not reappear after a reset.
    const firstRunComplete = this.settings.firstRunComplete;
    const prev = this.settings;
    this.settings = { ...DEFAULT_SETTINGS, firstRunComplete };
    const changed = (Object.keys(this.settings) as (keyof Settings)[]).filter(
      (k) => JSON.stringify(prev[k]) !== JSON.stringify(this.settings[k]),
    );
    this.flush();
    for (const l of this.listeners) l(this.get(), changed);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), this.saveDelayMs);
  }

  /** Writes pending changes immediately (also called on quit). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      writeJsonAtomic(this.file, this.settings);
    } catch {
      console.error("[settings] Failed to save settings.");
    }
  }
}

/**
 * Opt-in local memory of user-approved facts. Stored only on this machine;
 * the user can view, edit, and delete every item.
 */
export class MemoryStore {
  private items: MemoryItem[];
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, "memory.json");
    const raw = readJson(this.file);
    this.items = Array.isArray(raw) ? raw.filter(isMemoryItem).slice(0, MAX_MEMORY_ITEMS) : [];
  }

  list(): MemoryItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  add(text: unknown): { ok: true; item: MemoryItem } | { ok: false; error: string } {
    const v = validateMemoryText(text);
    if (!v.ok) return v;
    if (this.items.length >= MAX_MEMORY_ITEMS) return { ok: false, error: `Memory is full (max ${MAX_MEMORY_ITEMS} items).` };
    const item: MemoryItem = { id: randomUUID().replace(/-/g, "").slice(0, 16), text: v.value, createdAt: new Date().toISOString() };
    this.items.push(item);
    this.save();
    return { ok: true, item };
  }

  edit(id: string, text: unknown): { ok: true } | { ok: false; error: string } {
    const v = validateMemoryText(text);
    if (!v.ok) return v;
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: "Memory item not found." };
    item.text = v.value;
    this.save();
    return { ok: true };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  clear(): void {
    this.items = [];
    this.save();
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.items);
    } catch {
      console.error("[memory] Failed to save memory.");
    }
  }
}

function isMemoryItem(v: unknown): v is MemoryItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.text === "string" && typeof o.createdAt === "string";
}
