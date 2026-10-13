import Anthropic from "@anthropic-ai/sdk";
import type { ChatErrorKind } from "../shared/types";

export interface FriendlyError {
  kind: ChatErrorKind;
  message: string;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Anthropic.APIUserAbortError || (err instanceof Error && err.name === "AbortError");
}

/**
 * Maps SDK errors to short, user-facing messages. Internal details (stack
 * traces, request ids, raw bodies) are deliberately not shown to users.
 * Order matters: most specific classes first.
 */
export function toFriendlyError(err: unknown): FriendlyError {
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: "auth", message: "Your API key was rejected. Check it in Settings → AI." };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { kind: "auth", message: "This API key isn't allowed to use that model. Try another model in Settings → AI." };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { kind: "not_found", message: "That model wasn't found. Check the model name in Settings → AI." };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: "rate_limit", message: "I'm being rate limited right now. Give it a minute and try again." };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { kind: "bad_request", message: "Claude couldn't process that request. Try rephrasing, or clear the chat history." };
  }
  if (err instanceof Anthropic.InternalServerError) {
    if (err.status === 529) {
      return { kind: "overloaded", message: "Claude is overloaded at the moment. Please try again shortly." };
    }
    return { kind: "unknown", message: "Claude's servers had a hiccup. Please try again." };
  }
  // Timeout is a subclass of connection error, so it must come first.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: "network", message: "The request timed out. Check your connection and try again." };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: "network", message: "I couldn't reach Claude. Check your internet connection." };
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) {
      return { kind: "auth", message: "There's a billing problem with this API account. Check the Anthropic Console." };
    }
    if (err.status === 413) {
      return { kind: "bad_request", message: "That conversation got too long. Clear the chat history and try again." };
    }
  }
  return { kind: "unknown", message: "Something went wrong talking to Claude. Please try again." };
}
