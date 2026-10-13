import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { toFriendlyError } from "../src/main/chat-errors";
import { ChatService, trimHistory, type ChatContext, type ChatHooks } from "../src/main/chat-service";
import type { ChatStream, StreamFactory, StreamRequest } from "../src/main/claude-client";
import { OfflineBrain } from "../src/main/offline-brain";
import { buildSystemPrompt } from "../src/main/personality";
import type { ChatEvent } from "../src/shared/types";

const ctx = (over: Partial<ChatContext> = {}): ChatContext => ({
  aiEnabled: true,
  apiKey: "sk-ant-test-key-000000000000000",
  model: "claude-opus-5-5",
  name: "Clawd",
  personality: "playful",
  memory: null,
  ...over,
});

function hooks(): ChatHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onThinking: () => calls.push("thinking"),
    onFirstToken: () => calls.push("first"),
    onDone: (_t, source) => calls.push(`done:${source}`),
    onError: (m) => calls.push(`error:${m}`),
    onCancelled: () => calls.push("cancelled"),
  };
}

/** A controllable fake stream. */
function fakeStream(chunks: string[], opts: { stopReason?: string; failWith?: unknown; gate?: Promise<void> } = {}): ChatStream & { aborted: boolean } {
  const state = { aborted: false };
  async function* deltas(): AsyncGenerator<string> {
    for (const c of chunks) {
      if (opts.gate) await opts.gate;
      if (state.aborted) throw new Anthropic.APIUserAbortError();
      yield c;
    }
    if (opts.failWith) throw opts.failWith;
  }
  return {
    get aborted() {
      return state.aborted;
    },
    textDeltas: deltas(),
    final: async () => ({ stopReason: opts.stopReason ?? "end_turn", text: chunks.join("") }),
    abort: () => {
      state.aborted = true;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(factory: StreamFactory) {
  const events: ChatEvent[] = [];
  const service = new ChatService(factory, new OfflineBrain(() => 0), (e) => events.push(e));
  return { service, events };
}

describe("chat service", () => {
  it("streams Claude replies and records history", async () => {
    let request: StreamRequest | null = null;
    const { service, events } = setup((req) => {
      request = req;
      return fakeStream(["Hel", "lo!"]);
    });
    const h = hooks();
    const r = await service.send("hi", ctx(), h);
    expect(r.ok).toBe(true);
    await vi.waitFor(() => expect(h.calls).toContain("done:claude"));
    expect(h.calls).toEqual(["thinking", "first", "done:claude"]);
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "delta", "done"]);
    expect(events[0]).toMatchObject({ source: "claude", prompt: "hi" });
    expect(request!.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(service.historyLength).toBe(2);
    expect(service.transcript()).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello!", source: "claude" },
    ]);
    expect(service.busy).toBe(false);
  });

  it("uses the offline brain when AI is disabled or there is no key — and labels it", async () => {
    const factory = vi.fn<StreamFactory>();
    const { service, events } = setup(factory);
    for (const c of [ctx({ aiEnabled: false }), ctx({ apiKey: null })]) {
      const h = hooks();
      await service.send("hello", c, h);
      expect(h.calls).toEqual(["done:offline"]);
    }
    expect(factory).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === "start").every((e) => e.type === "start" && e.source === "offline")).toBe(true);
    expect(service.historyLength).toBe(0); // offline replies never enter Claude's history
    expect(service.transcript().filter((t) => t.role === "assistant").every((t) => t.source === "offline")).toBe(true);
  });

  it("rejects a second message while busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = setup(() => fakeStream(["a"], { gate }));
    await service.send("one", ctx(), hooks());
    const second = await service.send("two", ctx(), hooks());
    expect(second).toEqual({ ok: false, error: expect.stringMatching(/Still answering/) });
    release();
    await vi.waitFor(() => expect(service.busy).toBe(false));
  });

  it("cancels an in-flight request without adding history", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stream = fakeStream(["a", "b"], { gate });
    const { service, events } = setup(() => stream);
    const h = hooks();
    await service.send("hi", ctx(), h);
    await flush();
    expect(service.cancel()).toBe(true);
    expect(stream.aborted).toBe(true);
    release();
    await vi.waitFor(() => expect(h.calls).toContain("cancelled"));
    expect(events.at(-1)?.type).toBe("cancelled");
    expect(service.historyLength).toBe(0);
    expect(service.cancel()).toBe(false);
  });

  it("maps API errors to friendly messages", async () => {
    const authErr = Anthropic.APIError.generate(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid", new Headers());
    const { service, events } = setup(() => fakeStream(["partial"], { failWith: authErr }));
    const h = hooks();
    await service.send("hi", ctx(), h);
    await vi.waitFor(() => expect(h.calls.some((c) => c.startsWith("error:"))).toBe(true));
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ kind: "auth" });
    expect(JSON.stringify(err)).not.toContain("x-api-key");
    expect(service.historyLength).toBe(0);
  });

  it("treats a refusal stop reason as an error, not a reply", async () => {
    const { service, events } = setup(() => fakeStream(["I can"], { stopReason: "refusal" }));
    const h = hooks();
    await service.send("hi", ctx(), h);
    await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true));
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "refusal" });
    expect(service.historyLength).toBe(0);
  });

  it("handles a factory that throws synchronously", async () => {
    const { service, events } = setup(() => {
      throw new Anthropic.APIConnectionError({ message: "offline" });
    });
    const h = hooks();
    await service.send("hi", ctx(), h);
    await vi.waitFor(() => expect(events.some((e) => e.type === "error")).toBe(true));
    expect(events.find((e) => e.type === "error")).toMatchObject({ kind: "network" });
    expect(service.busy).toBe(false);
  });

  it("clear() wipes history and transcript", async () => {
    const { service } = setup(() => fakeStream(["ok"]));
    const h = hooks();
    await service.send("hi", ctx(), h);
    await vi.waitFor(() => expect(h.calls).toContain("done:claude"));
    service.clear();
    expect(service.historyLength).toBe(0);
    expect(service.transcript()).toEqual([]);
  });
});

describe("history trimming", () => {
  it("keeps the most recent messages and always starts with a user turn", () => {
    const msgs = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: String(i) }) as Anthropic.MessageParam);
    const t = trimHistory(msgs, 10);
    expect(t.length).toBeLessThanOrEqual(10);
    expect(t[0]?.role).toBe("user");
    expect(t.at(-1)?.content).toBe("24");
  });
});

describe("error mapping", () => {
  const gen = (status: number) => Anthropic.APIError.generate(status, { error: { message: "raw internal detail" } }, "raw internal detail", new Headers());
  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "rate_limit"],
    [400, "bad_request"],
    [529, "overloaded"],
    [500, "unknown"],
  ])("status %i → %s", (status, kind) => {
    const f = toFriendlyError(gen(status));
    expect(f.kind).toBe(kind);
    expect(f.message).not.toContain("raw internal detail");
  });
  it("network errors and unknown values", () => {
    expect(toFriendlyError(new Anthropic.APIConnectionError({ message: "x" })).kind).toBe("network");
    expect(toFriendlyError(new Anthropic.APIConnectionTimeoutError()).message).toMatch(/timed out/);
    expect(toFriendlyError(new Error("boom")).kind).toBe("unknown");
    expect(toFriendlyError("weird").kind).toBe("unknown");
  });
});

describe("personality & offline brain", () => {
  it("system prompt includes approved memory only when given", () => {
    const without = buildSystemPrompt({ name: "Pip", personality: "calm", memory: null });
    expect(without).toContain("You are Pip");
    expect(without).not.toContain("remember");
    const withMem = buildSystemPrompt({ name: "Pip", personality: "calm", memory: [{ id: "a", text: "likes tea", createdAt: "" }] });
    expect(withMem).toContain("- likes tea");
  });
  it("offline brain answers common intents", () => {
    const b = new OfflineBrain(() => 0);
    expect(b.reply("what can you do?", "playful", "Clawd")).toMatch(/Here's what I can do/);
    expect(b.reply("tell me something", "playful", "Clawd")).toMatch(/^Fun fact/);
    expect(b.reply("what's your name", "playful", "Pip")).toContain("Pip");
    expect(b.reply("explain quantum physics", "playful", "Clawd")).toMatch(/offline|Settings/i);
  });
});
