import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_EFFORT, MAX_OUTPUT_TOKENS } from "../shared/constants";

/** A narrow streaming interface so ChatService can be tested without the network. */
export interface ChatStream {
  textDeltas: AsyncIterable<string>;
  final(): Promise<{ stopReason: string | null; text: string }>;
  abort(): void;
}

/** How a request reaches Claude. */
export type AiConnection =
  | { provider: "api"; apiKey: string }
  | { provider: "claude-code"; cliPath: string; workDir: string };

export interface StreamRequest {
  connection: AiConnection;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
}

export type StreamFactory = (req: StreamRequest) => ChatStream;

let cached: { key: string; client: Anthropic } | null = null;

function clientFor(apiKey: string): Anthropic {
  if (cached?.key !== apiKey) {
    cached = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }) };
  }
  return cached.client;
}

/**
 * Real implementation backed by the official SDK. Runs only in the main
 * process; the API key never reaches a renderer.
 *
 * Server-side fallbacks ("default") are enabled so that if the model declines
 * a request on safety grounds, the API can retry on a suitable model.
 */
export const anthropicStreamFactory: StreamFactory = (req) => {
  if (req.connection.provider !== "api") throw new Error("anthropicStreamFactory needs an API-key connection.");
  const stream = clientFor(req.connection.apiKey).beta.messages.stream({
    model: req.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: req.messages,
    output_config: { effort: DEFAULT_EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  async function* deltas(): AsyncGenerator<string> {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  }

  return {
    textDeltas: deltas(),
    async final() {
      const message = await stream.finalMessage();
      const text = message.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return { stopReason: message.stop_reason, text };
    },
    abort: () => stream.abort(),
  };
};

/** Lightweight credential/model check. models.retrieve does not consume tokens. */
export async function testConnection(apiKey: string, model: string): Promise<void> {
  await clientFor(apiKey).models.retrieve(model);
}
