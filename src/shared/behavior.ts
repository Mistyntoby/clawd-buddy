import type { AnimationName } from "./types";

/**
 * Deterministic companion behavior state machine: the single source of truth
 * for what Clawd is doing.
 *
 * Every state maps 1:1 to an animation name. Transitions are a pure function of
 * (state, event); events that are not valid in the current state are ignored
 * (the function returns null) so callers never end up with conflicting loops.
 *
 * Priorities are encoded in the table. The user holding Clawd (pickup, drag,
 * land) outranks everything: DRAG_START is accepted from every state, and while
 * Clawd is held or landing, no autonomous, chat, or reaction event can change
 * the state. Only PICKED_UP, DROP, LANDED, and RESET apply there.
 */

export type BehaviorState = AnimationName;

export type BehaviorEvent =
  | "WANDER_START"
  | "ARRIVED"
  | "IDLE_VARIATION"
  | "CHAT_START"
  | "FIRST_TOKEN"
  | "SPEAK"
  | "SPEECH_END"
  | "ERROR"
  | "CANCEL"
  | "REACT_HAPPY"
  | "FIDGET"
  | "WAVE"
  | "IDEA"
  | "ONE_SHOT_END"
  | "SLEEP"
  | "WAKE"
  | "DRAG_START"
  | "PICKED_UP"
  | "DROP"
  | "LANDED"
  | "RESET";

type TransitionTable = Record<BehaviorState, Partial<Record<BehaviorEvent, BehaviorState>>>;

/** Shared by every state the user can grab Clawd from. */
const GRAB = { DRAG_START: "pickup" } as const;

const TABLE: TransitionTable = {
  idle: {
    ...GRAB,
    WANDER_START: "walk",
    IDLE_VARIATION: "idle-variation",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    FIDGET: "action",
    WAVE: "wave",
    IDEA: "idea",
    ERROR: "confused",
    SLEEP: "sleep",
  },
  "idle-variation": {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    WAVE: "wave",
    ERROR: "confused",
  },
  walk: {
    ...GRAB,
    ARRIVED: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    ERROR: "confused",
  },
  think: {
    ...GRAB,
    FIRST_TOKEN: "talk",
    SPEAK: "talk",
    ERROR: "confused",
    CANCEL: "idle",
  },
  talk: {
    ...GRAB,
    SPEECH_END: "idle",
    CHAT_START: "think",
    // Punchlines and successes react while the bubble stays up.
    REACT_HAPPY: "happy",
    IDEA: "idea",
    ERROR: "confused",
    CANCEL: "idle",
  },
  happy: {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    ERROR: "confused",
  },
  confused: {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
  },
  sleep: {
    ...GRAB,
    WAKE: "wake",
    CHAT_START: "think",
    SPEAK: "talk",
  },
  wake: {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
  },
  action: {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    ERROR: "confused",
  },
  idea: {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    REACT_HAPPY: "happy",
    ERROR: "confused",
  },
  wave: {
    ...GRAB,
    ONE_SHOT_END: "idle",
    CHAT_START: "think",
    SPEAK: "talk",
    ERROR: "confused",
  },
  pickup: {
    PICKED_UP: "drag",
    DROP: "land",
  },
  drag: {
    DROP: "land",
  },
  land: {
    LANDED: "idle",
  },
};

/** RESET is valid from every state. */
export function transition(state: BehaviorState, event: BehaviorEvent): BehaviorState | null {
  if (event === "RESET") return state === "idle" ? null : "idle";
  return TABLE[state][event] ?? null;
}

/**
 * Relative importance of each state, highest first. The transition table is
 * what enforces it; this is used by tests and documentation to check that no
 * lower-priority event can interrupt a higher-priority state.
 */
export const STATE_PRIORITY: Readonly<Record<BehaviorState, number>> = {
  pickup: 100,
  drag: 100,
  land: 90,
  think: 60,
  talk: 60,
  confused: 50,
  happy: 50,
  wake: 45,
  wave: 25,
  idea: 25,
  action: 20,
  "idle-variation": 20,
  walk: 15,
  sleep: 10,
  idle: 0,
};

/** States that end on their own after their animation plays once. */
export const ONE_SHOT_STATES: ReadonlySet<BehaviorState> = new Set(["happy", "confused", "wake", "action", "wave", "idea", "idle-variation", "pickup", "land"]);

/** States in which the user is holding Clawd or it is landing; nothing else may move the window or change the pose. */
export function isHeld(state: BehaviorState): boolean {
  return state === "pickup" || state === "drag" || state === "land";
}

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
