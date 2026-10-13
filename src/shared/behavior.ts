import type { AnimationName } from "./types";

/**
 * Deterministic companion behavior state machine.
 *
 * Every state maps 1:1 to an animation name. Transitions are a pure function of
 * (state, event); events that are not valid in the current state are ignored
 * (the function returns null) so callers never end up with conflicting loops.
 */

export type BehaviorState = AnimationName;

export type BehaviorEvent =
  | "WANDER_START"
  | "ARRIVED"
  | "CHAT_START"
  | "FIRST_TOKEN"
  | "SPEAK"
  | "SPEECH_END"
  | "ERROR"
  | "CANCEL"
  | "REACT_HAPPY"
  | "FIDGET"
  | "ONE_SHOT_END"
  | "SLEEP"
  | "WAKE"
  | "DRAG_START"
  | "RESET";

type TransitionTable = Record<BehaviorState, Partial<Record<BehaviorEvent, BehaviorState>>>;

const TABLE: TransitionTable = {
  idle: {
    WANDER_START: "walk",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    FIDGET: "action",
    ERROR: "confused",
    SLEEP: "sleep",
  },
  walk: {
    ARRIVED: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    ERROR: "confused",
    DRAG_START: "idle",
  },
  think: {
    FIRST_TOKEN: "talk",
    SPEAK: "talk",
    ERROR: "confused",
    CANCEL: "idle",
  },
  talk: {
    SPEECH_END: "idle",
    CHAT_START: "think",
    ERROR: "confused",
    CANCEL: "idle",
  },
  happy: {
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    DRAG_START: "idle",
  },
  confused: {
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    DRAG_START: "idle",
  },
  sleep: {
    WAKE: "wake",
    CHAT_START: "think",
    SPEAK: "talk",
    DRAG_START: "idle",
  },
  wake: {
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    DRAG_START: "idle",
  },
  action: {
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    DRAG_START: "idle",
  },
};

/** RESET is valid from every state. */
export function transition(state: BehaviorState, event: BehaviorEvent): BehaviorState | null {
  if (event === "RESET") return state === "idle" ? null : "idle";
  return TABLE[state][event] ?? null;
}

/** States that end on their own after a fixed duration. */
export const ONE_SHOT_STATES: ReadonlySet<BehaviorState> = new Set(["happy", "confused", "wake", "action"]);

/** States in which autonomous wandering/sleeping may begin. */
export function isIdleLike(state: BehaviorState): boolean {
  return state === "idle";
}

/** States during which the companion is busy with the user and must not wander. */
export function isBusy(state: BehaviorState): boolean {
  return state === "think" || state === "talk";
}

/** Small observable wrapper so the main process has exactly one source of truth. */
export class BehaviorMachine {
  private current: BehaviorState = "idle";
  private readonly listeners = new Set<(next: BehaviorState, prev: BehaviorState, event: BehaviorEvent) => void>();

  get state(): BehaviorState {
    return this.current;
  }

  /** Applies an event. Returns true if the state changed. */
  send(event: BehaviorEvent): boolean {
    const next = transition(this.current, event);
    if (next === null) return false;
    const prev = this.current;
    this.current = next;
    for (const listener of this.listeners) listener(next, prev, event);
    return true;
  }

  onChange(listener: (next: BehaviorState, prev: BehaviorState, event: BehaviorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
