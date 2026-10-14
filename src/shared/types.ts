/** Types shared between main, preload, and renderer. Keep this file free of runtime imports. */

export const ANIMATION_NAMES = [
  "idle",
  "idle-variation",
  "idea",
  "walk",
  "think",
  "talk",
  "happy",
  "confused",
  "sleep",
  "wake",
  "action",
  "wave",
  "pickup",
  "drag",
  "land",
] as const;

export type AnimationName = (typeof ANIMATION_NAMES)[number];

export type Facing = "left" | "right";

export type MovementSpeed = "slow" | "normal" | "fast";

export type Personality = "playful" | "calm" | "concise";

/** How often Clawd makes unprompted remarks. */
export type IdleChatter = "off" | "quiet" | "chatty";

/** How lively idle behavior and squash-and-stretch are. */
export type AnimationIntensity = "calm" | "normal" | "lively";

/**
 * How Claude is reached: "api" uses the user's own Anthropic API key;
 * "claude-code" runs the locally installed Claude Code CLI, which is signed in
 * with the user's Claude subscription.
 */
export type AiProvider = "api" | "claude-code";

export interface Settings {
  version: 1;
  firstRunComplete: boolean;
  companionName: string;
  personality: Personality;
  wandering: boolean;
  movementSpeed: MovementSpeed;
  alwaysOnTop: boolean;
  soundEnabled: boolean;
  launchAtStartup: boolean;
  /** Integer pixel scale for the sprite (2–6). */
  characterScale: number;
  idleChatter: IdleChatter;
  animationIntensity: AnimationIntensity;
  /** Keep the recent conversation on this computer between restarts. */
  keepChatHistory: boolean;
  /** Read Clawd's chat replies aloud with a system voice. */
  readAloud: boolean;
  /** Tones down squash-and-stretch and other purely decorative motion. The OS setting is honored too. */
  reducedMotion: boolean;
  openChatOnStartup: boolean;
  chatAlwaysOnTop: boolean;
  aiEnabled: boolean;
  aiProvider: AiProvider;
  model: string;
  memoryEnabled: boolean;
  spritePack: string;
  /** Last companion window position; null means "use default placement". */
  position: { x: number; y: number } | null;
}

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: string;
}

/** One playable frame sequence. */
export interface ResolvedSequence {
  /** Asset URLs (custom protocol) for each frame, when the pack uses individual frames. */
  frames?: string[];
  /** Asset URL of a horizontal sprite strip, when the pack uses sheets. */
  sheet?: string;
  frameCount: number;
  fps: number;
  loop: boolean;
  /** Frame index looping restarts from, so an intro plays only once. Default 0. */
  loopStart: number;
  /** Optional display name, used for the "Do a trick" menu. */
  label?: string;
}

/** A resolved, validated animation ready for the renderer, with optional alternative sequences. */
export interface ResolvedAnimation extends ResolvedSequence {
  /** Other sequences for the same state; one is picked at random each time it plays. */
  variants: ResolvedSequence[];
}

export interface SpritePackInfo {
  id: string;
  name: string;
  official: boolean;
  placeholder: boolean;
  author: string;
  source: string;
  license: string;
  attribution: string;
  frameWidth: number;
  frameHeight: number;
  /**
   * The character's body in its standing pose, in frame pixels [x, y, w, h].
   * Used to keep Clawd itself (not the transparent frame around it) on screen,
   * to place the speech bubble, and to anchor squash-and-stretch.
   */
  bodyBox: [number, number, number, number];
  animations: Partial<Record<AnimationName, ResolvedAnimation>>;
  /** Animations that are missing and will use a fallback. */
  missing: AnimationName[];
  warnings: string[];
}

export interface CompanionView {
  animation: AnimationName;
  facing: Facing;
  /** Increments each time the controller (re)starts an animation, so one-shots can replay. */
  seq: number;
  /** Which of the animation's variants to play (0 = the main sequence). */
  variant: number;
}

export interface SpeechPayload {
  text: string;
  /** Where the text came from — never label offline text as Claude. */
  source: "claude" | "offline" | "system";
  /** When true, more text will follow (streaming). */
  streaming?: boolean;
  durationMs?: number;
}

export type ChatEvent =
  | { type: "start"; requestId: string; source: "claude" | "offline"; prompt: string }
  | { type: "delta"; requestId: string; text: string }
  | { type: "done"; requestId: string; text: string; stopReason: string | null }
  | { type: "error"; requestId: string; message: string; kind: ChatErrorKind }
  | { type: "cancelled"; requestId: string }
  | ChatNotice;

export type ChatErrorKind =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "network"
  | "bad_request"
  | "not_found"
  | "refusal"
  | "unknown";

export interface ChatNotice {
  type: "notice";
  entry: TranscriptEntry;
}

export interface TranscriptEntry {
  role: "user" | "assistant" | "error" | "system";
  text: string;
  /** For assistant entries: who produced the text. */
  source?: "claude" | "offline";
}

export interface AiStatus {
  enabled: boolean;
  provider: AiProvider;
  /** True when replies will come from Claude (enabled and the selected provider is usable). */
  ready: boolean;
  hasKey: boolean;
  /** True when a Claude Code CLI executable was found on this computer. */
  claudeCodeFound: boolean;
  keySource: "saved" | "environment" | "session" | "none";
  /** True when OS-level encryption is available for saving the key. */
  secureStorageAvailable: boolean;
  model: string;
}

export interface CapabilityInfo {
  launchAtStartupSupported: boolean;
  launchAtStartupReason: string | null;
  platform: string;
  version: string;
}

export interface ContextMenuRequest {
  x: number;
  y: number;
}
