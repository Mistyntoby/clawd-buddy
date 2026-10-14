import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { MAX_HISTORY_MESSAGES } from "../shared/constants";
import type { ChatEvent, MemoryItem, Personality, TranscriptEntry } from "../shared/types";
import { isAbortError, toFriendlyError } from "./chat-errors";
import type { AiConnection, ChatStream, StreamFactory } from "./claude-client";
import type { OfflineBrain } from "./offline-brain";
import { buildSystemPrompt } from "./personality";

const TRANSCRIPT_MAX = 200;
/** How much of the conversation is kept on disk when "Keep chat history" is on. */
export const SAVED_TRANSCRIPT_MAX = 100;

/** Where the recent conversation is persisted. Implemented with a JSON file in the app's data folder. */
export interface ChatPersistence {
  load(): { history: Anthropic.MessageParam[]; log: TranscriptEntry[] } | null;
  save(data: { history: Anthropic.MessageParam[]; log: TranscriptEntry[] } | null): void;
}

function isEntry(v: unknown): v is TranscriptEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return ["user", "assistant", "error", "system"].includes(e.role as string) && typeof e.text === "string";
}

function isMessage(v: unknown): v is Anthropic.MessageParam {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}

/** Validates persisted chat data (it is read back from disk, so treat it as untrusted). */
export function sanitizeSavedChat(raw: unknown): { history: Anthropic.MessageParam[]; log: TranscriptEntry[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const log = Array.isArray(r.log) ? r.log.filter(isEntry).slice(-SAVED_TRANSCRIPT_MAX) : [];
  const history = trimHistory(Array.isArray(r.history) ? r.history.filter(isMessage) : []);
  return { history, log };
}

export interface ChatContext {
  /** How to reach Claude, or null for offline mode (AI disabled or not set up). */
  connection: AiConnection | null;
  model: string;
  name: string;
  personality: Personality;
  memory: MemoryItem[] | null;
}

export interface ChatHooks {
  /** Waiting for the first token. */
  onThinking(): void;
  /** First text arrived. */
  onFirstToken(): void;
  /** Finished successfully with the full text. */
  onDone(text: string, source: "claude" | "offline"): void;
  onError(message: string): void;
  onCancelled(): void;
}

/**
 * Keeps the last `max` messages, making sure the history starts with a user
 * turn so the API always receives a valid alternating conversation.
 */
export function trimHistory(history: Anthropic.MessageParam[], max = MAX_HISTORY_MESSAGES): Anthropic.MessageParam[] {
  let trimmed = history.slice(-max);
  while (trimmed.length > 0 && trimmed[0]?.role !== "user") trimmed = trimmed.slice(1);
  return trimmed;
}

/**
 * Owns the conversation and the single in-flight request.
 * Offline replies are emitted with source "offline" and are not added to the
 * Claude conversation history.
 */
export class ChatService {
  private history: Anthropic.MessageParam[] = [];
  /** What the chat window displays (includes offline replies and errors). */
  private log: TranscriptEntry[] = [];
  private active: { id: string; stream: ChatStream | null; cancelled: boolean } | null = null;

  private persistence: ChatPersistence | null = null;

  constructor(
    private readonly factory: StreamFactory,
    private readonly offline: OfflineBrain,
    private readonly emit: (event: ChatEvent) => void,
  ) {}

  /** Turns persistence on (restoring the saved conversation) or off (deleting it). */
  setPersistence(p: ChatPersistence | null): void {
    if (!p) {
      this.persistence?.save(null);
      this.persistence = null;
      return;
    }
    this.persistence = p;
    const saved = sanitizeSavedChat(p.load());
    if (saved && this.log.length === 0) {
      this.history = saved.history;
      this.log = saved.log;
    }
  }

  private persist(): void {
    this.persistence?.save({ history: this.history, log: this.log.slice(-SAVED_TRANSCRIPT_MAX) });
  }

  /** Adds a local line (command output, reminders, jokes) to the chat without involving Claude. */
  notice(entry: TranscriptEntry, echo?: string): void {
    if (echo !== undefined) {
      this.record({ role: "user", text: echo });
      this.emit({ type: "notice", entry: { role: "user", text: echo } });
    }
    this.record(entry);
    this.emit({ type: "notice", entry });
  }

  get busy(): boolean {
    return this.active !== null;
  }

  get historyLength(): number {
    return this.history.length;
  }

  transcript(): TranscriptEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  private record(entry: TranscriptEntry): void {
    this.log.push(entry);
    if (this.log.length > TRANSCRIPT_MAX) this.log = this.log.slice(-TRANSCRIPT_MAX);
    this.persist();
  }

  /** Starts a reply. Returns the request id, or an error if a reply is already in progress. */
  async send(text: string, ctx: ChatContext, hooks: ChatHooks): Promise<{ ok: true; requestId: string } | { ok: false; error: string }> {
    if (this.active) return { ok: false, error: "Still answering the previous message." };
    const requestId = randomUUID();

    if (!ctx.connection) {
      const reply = this.offline.reply(text, ctx.personality, ctx.name);
      this.record({ role: "user", text });
      this.record({ role: "assistant", text: reply, source: "offline" });
      this.emit({ type: "start", requestId, source: "offline", prompt: text });
      this.emit({ type: "delta", requestId, text: reply });
      this.emit({ type: "done", requestId, text: reply, stopReason: null });
      hooks.onDone(reply, "offline");
      return { ok: true, requestId };
    }

    const request = { id: requestId, stream: null as ChatStream | null, cancelled: false };
    this.active = request;
    const messages = trimHistory([...this.history, { role: "user", content: text }]);
    this.record({ role: "user", text });
    this.emit({ type: "start", requestId, source: "claude", prompt: text });
    hooks.onThinking();

    void this.run(request, messages, ctx, hooks);
    return { ok: true, requestId };
  }

  private async run(
    request: { id: string; stream: ChatStream | null; cancelled: boolean },
    messages: Anthropic.MessageParam[],
    ctx: ChatContext,
    hooks: ChatHooks,
  ): Promise<void> {
    const requestId = request.id;
    let gotToken = false;
    try {
      const stream = this.factory({
        connection: ctx.connection as AiConnection,
        model: ctx.model,
        system: buildSystemPrompt({ name: ctx.name, personality: ctx.personality, memory: ctx.memory }),
        messages,
      });
      request.stream = stream;
      if (request.cancelled) stream.abort();

      for await (const delta of stream.textDeltas) {
        if (request.cancelled) break;
        if (!gotToken) {
          gotToken = true;
          hooks.onFirstToken();
        }
        this.emit({ type: "delta", requestId, text: delta });
      }
      if (request.cancelled) throw new CancelledError();

      const final = await stream.final();
      if (final.stopReason === "refusal") {
        this.record({ role: "error", text: "Sorry, I can't help with that one." });
        this.emit({ type: "error", requestId, kind: "refusal", message: "Sorry, I can't help with that one." });
        hooks.onError("Sorry, I can't help with that one.");
        return;
      }
      const reply = final.text.length > 0 ? final.text : "…";
      this.history = trimHistory([...messages, { role: "assistant", content: reply }]);
      this.record({ role: "assistant", text: reply, source: "claude" });
      this.emit({ type: "done", requestId, text: reply, stopReason: final.stopReason });
      hooks.onDone(reply, "claude");
    } catch (err) {
      if (request.cancelled || isAbortError(err) || err instanceof CancelledError) {
        this.record({ role: "system", text: "Stopped." });
        this.emit({ type: "cancelled", requestId });
        hooks.onCancelled();
      } else {
        const friendly = toFriendlyError(err);
        // Log only the class/status, never request bodies or keys.
        console.warn(`[chat] Request failed: ${friendly.kind}`);
        this.record({ role: "error", text: friendly.message });
        this.emit({ type: "error", requestId, kind: friendly.kind, message: friendly.message });
        hooks.onError(friendly.message);
      }
    } finally {
      if (this.active === request) this.active = null;
    }
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.cancelled = true;
    this.active.stream?.abort();
    return true;
  }

  clear(): void {
    this.cancel();
    this.history = [];
    this.log = [];
    this.persist();
  }
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}
