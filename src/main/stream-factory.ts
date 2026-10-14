import { anthropicStreamFactory, type StreamFactory } from "./claude-client";
import { claudeCodeStreamFactory } from "./claude-code-client";

/** Routes each request to the backend selected in Settings → AI. */
export const defaultStreamFactory: StreamFactory = (req) =>
  req.connection.provider === "claude-code" ? claudeCodeStreamFactory(req) : anthropicStreamFactory(req);
