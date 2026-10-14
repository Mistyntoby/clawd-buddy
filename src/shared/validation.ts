import { MAX_MEMORY_ITEM_CHARS, MAX_USER_MESSAGE_CHARS } from "./constants";

/** Validators for untrusted values crossing the IPC boundary. */

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Format check for Anthropic API keys. This only catches obvious mistakes
 * (pasting the wrong thing, stray whitespace); the server is the real authority.
 */
export function validateApiKeyFormat(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "API key must be text." };
  const key = raw.trim();
  if (key.length === 0) return { ok: false, error: "API key is empty." };
  if (/\s/.test(key)) return { ok: false, error: "API key must not contain spaces or line breaks." };
  if (!key.startsWith("sk-ant-")) return { ok: false, error: 'Anthropic API keys start with "sk-ant-".' };
  if (key.length < 24 || key.length > 300) return { ok: false, error: "API key length looks wrong." };
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, error: "API key contains unexpected characters." };
  return { ok: true, value: key };
}

/** Masks a key for display: never show more than the prefix and last 4 chars. */
export function maskApiKey(key: string): string {
  if (key.length <= 12) return "••••";
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export function validateChatMessage(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "Message must be text." };
  // eslint-disable-next-line no-control-regex -- deliberately stripping NUL characters
  const text = raw.replace(/\u0000/g, "").trim();
  if (text.length === 0) return { ok: false, error: "Message is empty." };
  if (text.length > MAX_USER_MESSAGE_CHARS) {
    return { ok: false, error: `Message is too long (max ${MAX_USER_MESSAGE_CHARS} characters).` };
  }
  return { ok: true, value: text };
}

export function validateMemoryText(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "Memory must be text." };
  // eslint-disable-next-line no-control-regex -- deliberately stripping control characters
  const text = raw.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim();
  if (text.length === 0) return { ok: false, error: "Memory is empty." };
  if (text.length > MAX_MEMORY_ITEM_CHARS) {
    return { ok: false, error: `Memory is too long (max ${MAX_MEMORY_ITEM_CHARS} characters).` };
  }
  return { ok: true, value: text };
}

export function validateId(raw: unknown): Result<string> {
  if (typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return { ok: true, value: raw };
  return { ok: false, error: "Invalid id." };
}

export function validatePoint(raw: unknown): Result<{ x: number; y: number }> {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Point must be an object." };
  const p = raw as Record<string, unknown>;
  if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    return { ok: false, error: "Point coordinates must be finite numbers." };
  }
  if (Math.abs(p.x) > 100_000 || Math.abs(p.y) > 100_000) return { ok: false, error: "Point out of range." };
  return { ok: true, value: { x: Math.round(p.x), y: Math.round(p.y) } };
}

export function validateBoolean(raw: unknown): Result<boolean> {
  return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, error: "Expected a boolean." };
}

const COMMANDS = [
  "talk",
  "tell-me-something",
  "what-can-you-do",
  "open-chat",
  "open-settings",
  "hide",
  "poke",
  "pet",
  "joke",
  "fact",
  "reminders",
] as const;
export type CompanionCommand = (typeof COMMANDS)[number];

export function validateCommand(raw: unknown): Result<CompanionCommand> {
  return (COMMANDS as readonly unknown[]).includes(raw)
    ? { ok: true, value: raw as CompanionCommand }
    : { ok: false, error: "Unknown command." };
}

const SECTIONS = ["welcome", "behavior", "ai", "reminders", "memory", "character", "about"] as const;
export type SettingsSection = (typeof SECTIONS)[number];
export function validateSection(raw: unknown): Result<SettingsSection> {
  return (SECTIONS as readonly unknown[]).includes(raw)
    ? { ok: true, value: raw as SettingsSection }
    : { ok: false, error: "Unknown section." };
}

/** Detects "remember that …" chat messages so the UI can ask for explicit approval. */
export function extractRememberRequest(text: string): string | null {
  const m = /^\s*(?:\/remember|remember(?:\s+that)?)\s*[:,]?\s+(.+)$/is.exec(text);
  const fact = m?.[1]?.trim();
  return fact && fact.length > 0 ? fact.slice(0, MAX_MEMORY_ITEM_CHARS) : null;
}
