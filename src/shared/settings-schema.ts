import { DEFAULT_MODEL, PLACEHOLDER_PACK_ID } from "./constants";
import type { AiProvider, MovementSpeed, Personality, Settings } from "./types";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 1,
  firstRunComplete: false,
  companionName: "Clawd",
  personality: "playful",
  wandering: true,
  movementSpeed: "normal",
  alwaysOnTop: true,
  soundEnabled: true,
  launchAtStartup: false,
  characterScale: 3,
  ambientComments: true,
  showPlaceholderLabel: true,
  openChatOnStartup: false,
  chatAlwaysOnTop: false,
  aiEnabled: false,
  aiProvider: "api",
  model: DEFAULT_MODEL,
  memoryEnabled: false,
  spritePack: "auto",
  position: null,
});

const SPEEDS: readonly MovementSpeed[] = ["slow", "normal", "fast"];
const PERSONALITIES: readonly Personality[] = ["playful", "calm", "concise"];
const PROVIDERS: readonly AiProvider[] = ["api", "claude-code"];
const MODEL_ID = /^[a-z0-9][a-z0-9.\-_]{1,80}$/;
const PACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const MIN_SCALE = 2;
export const MAX_SCALE = 6;

type Validator = (value: unknown) => { ok: true; value: unknown } | { ok: false };

const ok = (value: unknown) => ({ ok: true as const, value });
const bad = { ok: false as const };

const bool: Validator = (v) => (typeof v === "boolean" ? ok(v) : bad);

/** Per-key validators. Keys absent here (version) cannot be changed via IPC. */
const VALIDATORS: Record<Exclude<keyof Settings, "version">, Validator> = {
  firstRunComplete: bool,
  companionName: (v) => {
    if (typeof v !== "string") return bad;
    // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
    const name = v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 24);
    return name.length > 0 ? ok(name) : bad;
  },
  personality: (v) => (PERSONALITIES.includes(v as Personality) ? ok(v) : bad),
  wandering: bool,
  movementSpeed: (v) => (SPEEDS.includes(v as MovementSpeed) ? ok(v) : bad),
  alwaysOnTop: bool,
  soundEnabled: bool,
  launchAtStartup: bool,
  characterScale: (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= MIN_SCALE && v <= MAX_SCALE ? ok(v) : bad,
  ambientComments: bool,
  showPlaceholderLabel: bool,
  openChatOnStartup: bool,
  chatAlwaysOnTop: bool,
  aiEnabled: bool,
  aiProvider: (v) => (PROVIDERS.includes(v as AiProvider) ? ok(v) : bad),
  model: (v) => (typeof v === "string" && MODEL_ID.test(v.trim()) ? ok(v.trim()) : bad),
  memoryEnabled: bool,
  spritePack: (v) => (typeof v === "string" && (v === "auto" || PACK_ID.test(v)) ? ok(v) : bad),
  position: (v) => {
    if (v === null) return ok(null);
    if (typeof v !== "object") return bad;
    const p = v as Record<string, unknown>;
    if (typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      return ok({ x: Math.round(p.x), y: Math.round(p.y) });
    }
    return bad;
  },
};

export type SettingsPatch = Partial<Omit<Settings, "version">>;

/**
 * Validates an untrusted settings patch (e.g. from IPC). Unknown keys and
 * invalid values are rejected rather than silently coerced.
 */
export function validateSettingsPatch(raw: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Settings patch must be an object." };
  }
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const validator = (VALIDATORS as Record<string, Validator | undefined>)[key];
    if (!validator) return { ok: false, error: `Unknown setting "${key}".` };
    const result = validator(value);
    if (!result.ok) return { ok: false, error: `Invalid value for "${key}".` };
    patch[key] = result.value;
  }
  return { ok: true, patch: patch as SettingsPatch };
}

/**
 * Builds a complete Settings object from whatever was on disk. Invalid or
 * missing fields fall back to defaults so a corrupted file never crashes the app.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const validator = (VALIDATORS as Record<string, Validator | undefined>)[key];
    if (!validator) continue;
    const r = validator(value);
    if (r.ok) (result as unknown as Record<string, unknown>)[key] = r.value;
  }
  return result;
}

export { PLACEHOLDER_PACK_ID };
