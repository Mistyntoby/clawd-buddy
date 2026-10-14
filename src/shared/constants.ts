/**
 * Central application constants. Model identifiers and other tunables live
 * here so they are not scattered through the codebase.
 */

export const APP_NAME = "Clawd Buddy";

/** Default Claude model. Users can override it in Settings → AI. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Models offered in the settings dropdown. Any valid model id may also be typed in. */
export const SUGGESTED_MODELS: readonly string[] = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];

/** Reasoning effort used for companion chat. Short, friendly replies don't need much. */
export const DEFAULT_EFFORT = "low" as const;

export const MAX_OUTPUT_TOKENS = 4096;

/** Maximum number of messages (user + assistant) sent as conversation context. */
export const MAX_HISTORY_MESSAGES = 20;

/** Maximum length of a single user chat message, in characters. */
export const MAX_USER_MESSAGE_CHARS = 4000;

export const MAX_MEMORY_ITEMS = 50;
export const MAX_MEMORY_ITEM_CHARS = 300;

/** Sprite base frame size is defined per pack; the window adds room for the speech bubble. */
export const BUBBLE_AREA_HEIGHT = 150;
export const COMPANION_MIN_WIDTH = 280;

export const MOVEMENT_SPEEDS = {
  slow: 40,
  normal: 70,
  fast: 115,
} as const;

/** Walking tick interval, ms (~60 fps). Only runs while actually walking. */
export const WALK_TICK_MS = 16;

/**
 * Motion tuning, all in one place. Window movement (main process) and sprite
 * effects (companion renderer) both read from here.
 */
export const MOTION = {
  walk: {
    /** Acceleration and braking, px/s². */
    accel: 160,
    /** Legs per wander outing, and the pause between legs, ms. */
    legsMin: 1,
    legsMax: 3,
    pauseMinMs: 700,
    pauseMaxMs: 1800,
  },
  drag: {
    /**
     * Safety-net interval while held, ms. The window normally moves on every
     * pointer event (event-driven, no frame cap); this only catches up if
     * events stop, and detects a release that was never reported.
     */
    watchdogMs: 100,
    /** A hold with no pointer events for this long is treated as released. */
    staleReleaseMs: 4000,
    /** Pointer travel before a press becomes a drag, CSS px. */
    thresholdPx: 4,
  },
  /** Chances for an idle decision (the rest: keep idling). */
  idle: {
    wander: 0.5,
    variation: 0.3,
    fidget: 0.08,
  },
  /**
   * Animation intensity levels: idleScale stretches the time between idle
   * decisions, extras scales the chance of variations and fidgets, squash
   * scales squash-and-stretch amplitude.
   */
  intensity: {
    calm: { idleScale: 1.6, extras: 0.5, squash: 0.5 },
    normal: { idleScale: 1, extras: 1, squash: 1 },
    lively: { idleScale: 0.6, extras: 1.5, squash: 1.25 },
  },
  /** Minimum time between two petting reactions, ms. */
  petCooldownMs: 2500,
  /** Sprite-level squash and stretch in the companion renderer. Scale factors are relative to 1. */
  squash: {
    pickup: { scaleX: 1.08, scaleY: 0.9 },
    carry: { scaleX: 0.96, scaleY: 1.05 },
    land: { scaleX: 1.14, scaleY: 0.84 },
    poke: { scaleX: 1.06, scaleY: 0.93 },
    /** Spring constants for the settle: stiffness (1/s²) and damping ratio. */
    stiffness: 420,
    damping: 0.48,
  },
} as const;

/** Idle duration range before the next wander decision, ms. */
export const IDLE_MIN_MS = 8_000;
export const IDLE_MAX_MS = 22_000;

/** Fall asleep after this long without user interaction, ms. */
export const SLEEP_AFTER_MS = 10 * 60_000;

/** Random remark interval ranges for each idle-chatter level, ms. */
export const AMBIENT_MIN_MS = 25 * 60_000;
export const AMBIENT_MAX_MS = 50 * 60_000;
export const CHATTY_MIN_MS = 6 * 60_000;
export const CHATTY_MAX_MS = 15 * 60_000;

/**
 * Fallback one-shot durations, ms, used when the sprite pack doesn't say how
 * long an animation is. With a pack, the duration is frames ÷ fps.
 */
export const ONE_SHOT_MS = {
  happy: 1800,
  confused: 2200,
  wake: 1200,
  action: 1600,
  wave: 1400,
  "idle-variation": 2400,
  pickup: 180,
  land: 420,
} as const;

/** Upper bound for any one-shot, so a long sprite sequence can't stall behavior. */
export const ONE_SHOT_MAX_MS = 6000;

/** Custom protocol used to serve validated sprite files to the renderer. */
export const ASSET_PROTOCOL = "clawd-asset";

export const PLACEHOLDER_PACK_ID = "placeholder";
