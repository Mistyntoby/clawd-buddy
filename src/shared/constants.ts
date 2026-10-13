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
export const LABEL_AREA_HEIGHT = 22;

export const MOVEMENT_SPEEDS = {
  slow: 40,
  normal: 70,
  fast: 115,
} as const;

/** Walking tick interval, ms (~30 fps). Only runs while actually walking. */
export const WALK_TICK_MS = 33;

/** Idle duration range before the next wander decision, ms. */
export const IDLE_MIN_MS = 8_000;
export const IDLE_MAX_MS = 22_000;

/** Fall asleep after this long without user interaction, ms. */
export const SLEEP_AFTER_MS = 10 * 60_000;

/** Random comment interval range when ambient comments are enabled, ms. */
export const AMBIENT_MIN_MS = 25 * 60_000;
export const AMBIENT_MAX_MS = 50 * 60_000;

/** One-shot animation durations, ms. */
export const ONE_SHOT_MS = {
  happy: 1800,
  confused: 2200,
  wake: 1200,
  action: 1600,
} as const;

/** Custom protocol used to serve validated sprite files to the renderer. */
export const ASSET_PROTOCOL = "clawd-asset";

export const PLACEHOLDER_PACK_ID = "placeholder";
