import { BehaviorMachine, type BehaviorEvent, type BehaviorState } from "../shared/behavior";
import {
  AMBIENT_MAX_MS,
  AMBIENT_MIN_MS,
  IDLE_MAX_MS,
  IDLE_MIN_MS,
  MOVEMENT_SPEEDS,
  ONE_SHOT_MS,
  SLEEP_AFTER_MS,
  WALK_TICK_MS,
} from "../shared/constants";
import {
  clampPosition,
  computeBounds,
  defaultPosition,
  findContainingArea,
  pickWanderTarget,
  randomBetween,
  stepToward,
  type Point,
  type Rect,
  type Rng,
  type Size,
} from "../shared/movement";
import type { CompanionView, Facing, MovementSpeed, SpeechPayload } from "../shared/types";

/** The slice of the companion window the controller needs. Implemented by WindowManager. */
export interface CompanionPort {
  getPosition(): Point;
  setPosition(p: Point): void;
  getSize(): Size;
  isVisible(): boolean;
  /** Work areas of all connected displays. */
  workAreas(): Rect[];
  /** Work area of the display nearest a point (e.g. the primary display as a fallback). */
  workAreaNear(p: Point): Rect;
  sendView(view: CompanionView): void;
  sendSpeech(speech: SpeechPayload | null): void;
  sendSound(sound: "pop" | "chime" | "blip" | "error"): void;
}

export interface ControllerOptions {
  rng?: Rng;
  /** Seconds since the user last used mouse/keyboard anywhere (OS-level). */
  systemIdleSeconds?: () => number;
  now?: () => number;
}

export interface ControllerSettings {
  wandering: boolean;
  movementSpeed: MovementSpeed;
  ambientComments: boolean;
}

const SPEECH_MIN_MS = 4000;
const SPEECH_MAX_MS = 16000;
const SPEECH_MS_PER_CHAR = 55;
const BUBBLE_MAX_CHARS = 280;
const SLEEP_POLL_MS = 5000;

/** Display duration scaled to text length so long replies can be read. */
export function speechDuration(text: string): number {
  return Math.min(SPEECH_MAX_MS, Math.max(SPEECH_MIN_MS, text.length * SPEECH_MS_PER_CHAR));
}

/** Truncates long text for the bubble; the full text is always in the chat window. */
export function bubbleText(text: string, max = BUBBLE_MAX_CHARS): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}… (see chat)`;
}

export class CompanionController {
  readonly machine = new BehaviorMachine();
  private facing: Facing = "right";
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private walkTimer: ReturnType<typeof setInterval> | null = null;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private walkTarget: number | null = null;
  private walkX = 0;
  private lastTick = 0;
  private dragging = false;
  private dragOffset: Point = { x: 0, y: 0 };
  private paused = false;
  private lastInteraction: number;
  private streamingText = "";
  private readonly rng: Rng;
  private readonly systemIdleSeconds: () => number;
  private readonly now: () => number;

  constructor(
    private readonly port: CompanionPort,
    private settings: ControllerSettings,
    private readonly ambientLine: () => string,
    opts: ControllerOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.systemIdleSeconds = opts.systemIdleSeconds ?? (() => 0);
    this.now = opts.now ?? Date.now;
    this.lastInteraction = this.now();
    this.machine.onChange((next, prev, event) => this.onStateChange(next, prev, event));
  }

  get state(): BehaviorState {
    return this.machine.state;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  start(): void {
    this.paused = false;
    this.publishView();
    this.scheduleIdle();
    this.scheduleAmbient();
  }

  /** Stops all timers (used when hidden or quitting). */
  pause(): void {
    this.paused = true;
    this.clearStateTimer();
    this.stopWalking();
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.machine.state === "walk") this.machine.send("ARRIVED");
    this.scheduleIdle();
    this.scheduleAmbient();
    this.publishView();
  }

  dispose(): void {
    this.pause();
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = null;
  }

  updateSettings(s: ControllerSettings): void {
    const wanderingTurnedOff = this.settings.wandering && !s.wandering;
    this.settings = s;
    if (wanderingTurnedOff && this.machine.state === "walk") this.machine.send("ARRIVED");
    if (this.machine.state === "idle") this.scheduleIdle();
    this.scheduleAmbient();
  }

  // ---- interaction --------------------------------------------------------

  noteInteraction(): void {
    this.lastInteraction = this.now();
    if (this.machine.state === "sleep") this.machine.send("WAKE");
  }

  poke(): void {
    const wasAsleep = this.machine.state === "sleep";
    this.noteInteraction();
    if (wasAsleep) return;
    if (this.machine.send("REACT_HAPPY")) this.port.sendSound("pop");
  }

  fidget(): void {
    this.noteInteraction();
    this.machine.send("FIDGET");
  }

  dragStart(cursor: Point): void {
    this.noteInteraction();
    const pos = this.port.getPosition();
    this.dragOffset = { x: cursor.x - pos.x, y: cursor.y - pos.y };
    this.dragging = true;
    this.machine.send("DRAG_START");
    this.stopWalking();
  }

  dragMove(cursor: Point): void {
    if (!this.dragging) return;
    this.port.setPosition({ x: cursor.x - this.dragOffset.x, y: cursor.y - this.dragOffset.y });
  }

  /** Ends a drag, snapping the window fully onto the display it was dropped on. Returns the final position. */
  dragEnd(): Point {
    this.dragging = false;
    const p = this.ensureOnScreen();
    if (this.machine.state === "idle") this.scheduleIdle();
    return p;
  }

  /**
   * Makes sure the window is fully inside some display's work area. Used after
   * drags, display changes, and at startup. Returns the corrected position.
   */
  ensureOnScreen(preferred?: Point | null): Point {
    const size = this.port.getSize();
    const pos = preferred ?? this.port.getPosition();
    const rect = { ...pos, ...size };
    const area = findContainingArea(rect, this.port.workAreas());
    const next = area
      ? clampPosition(pos, computeBounds(area, size))
      : defaultPosition(this.port.workAreaNear(pos), size);
    const cur = this.port.getPosition();
    if (cur.x !== next.x || cur.y !== next.y) this.port.setPosition(next);
    return next;
  }

  // ---- speech & chat ------------------------------------------------------

  say(text: string, source: SpeechPayload["source"], opts: { sound?: boolean } = {}): void {
    this.noteInteraction();
    this.streamingText = "";
    const shown = bubbleText(text);
    const durationMs = speechDuration(shown);
    if (this.machine.state !== "talk") this.machine.send("SPEAK");
    this.port.sendSpeech({ text: shown, source, durationMs });
    if (opts.sound !== false) this.port.sendSound("blip");
    this.armSpeechEnd(durationMs);
  }

  /** Quiet ambient line: no sound, only when idle. */
  sayAmbient(text: string): boolean {
    if (this.machine.state !== "idle") return false;
    this.say(text, "offline", { sound: false });
    return true;
  }

  chatThinking(): void {
    this.noteInteraction();
    this.clearSpeechTimer();
    this.streamingText = "";
    this.machine.send("CHAT_START");
    this.port.sendSpeech({ text: "…", source: "system", streaming: true });
  }

  chatFirstToken(): void {
    this.machine.send("FIRST_TOKEN");
    this.port.sendSound("blip");
  }

  chatDelta(text: string): void {
    this.streamingText += text;
    if (this.machine.state === "talk") {
      const tail = this.streamingText.length > BUBBLE_MAX_CHARS ? `…${this.streamingText.slice(-BUBBLE_MAX_CHARS)}` : this.streamingText;
      this.port.sendSpeech({ text: tail, source: "claude", streaming: true });
    }
  }

  chatDone(text: string, source: "claude" | "offline"): void {
    this.say(text, source, { sound: false });
  }

  chatError(message: string): void {
    this.clearSpeechTimer();
    this.streamingText = "";
    this.machine.send("ERROR");
    this.port.sendSpeech({ text: message, source: "system", durationMs: speechDuration(message) });
    this.port.sendSound("error");
    this.speechTimer = setTimeout(() => this.port.sendSpeech(null), speechDuration(message));
  }

  chatCancelled(): void {
    this.clearSpeechTimer();
    this.streamingText = "";
    this.machine.send("CANCEL");
    this.port.sendSpeech(null);
  }

  dismissSpeech(): void {
    this.clearSpeechTimer();
    this.port.sendSpeech(null);
    if (this.machine.state === "talk") this.machine.send("SPEECH_END");
  }

  private armSpeechEnd(ms: number): void {
    this.clearSpeechTimer();
    this.speechTimer = setTimeout(() => {
      this.speechTimer = null;
      this.port.sendSpeech(null);
      this.machine.send("SPEECH_END");
    }, ms);
  }

  private clearSpeechTimer(): void {
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = null;
  }

  // ---- state machine side effects ------------------------------------------

  private onStateChange(next: BehaviorState, prev: BehaviorState, _event: BehaviorEvent): void {
    this.clearStateTimer();
    if (prev === "walk") this.stopWalking();
    this.publishView();
    if (this.paused) return;

    switch (next) {
      case "idle":
        this.scheduleIdle();
        break;
      case "walk":
        this.beginWalk();
        break;
      case "happy":
      case "confused":
      case "wake":
      case "action":
        this.stateTimer = setTimeout(() => this.machine.send("ONE_SHOT_END"), ONE_SHOT_MS[next]);
        break;
      case "sleep":
        this.scheduleSleepPoll();
        break;
      default:
        break;
    }
  }

  private publishView(): void {
    this.port.sendView({ animation: this.machine.state, facing: this.facing });
  }

  private clearStateTimer(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
  }

  /** Schedules the next autonomous decision while idle. Exactly one timer at a time. */
  private scheduleIdle(): void {
    this.clearStateTimer();
    if (this.paused || this.machine.state !== "idle") return;
    this.stateTimer = setTimeout(() => this.decide(), randomBetween(this.rng, IDLE_MIN_MS, IDLE_MAX_MS));
  }

  private decide(): void {
    this.stateTimer = null;
    if (this.paused || this.dragging || this.machine.state !== "idle" || !this.port.isVisible()) {
      this.scheduleIdle();
      return;
    }
    const inactiveMs = this.now() - this.lastInteraction;
    if (inactiveMs >= SLEEP_AFTER_MS && this.systemIdleSeconds() >= 120) {
      this.machine.send("SLEEP");
      return;
    }
    const roll = this.rng();
    if (this.settings.wandering && roll < 0.65) {
      this.machine.send("WANDER_START");
    } else if (roll > 0.88) {
      this.machine.send("FIDGET");
    } else {
      this.scheduleIdle();
    }
  }

  private scheduleSleepPoll(): void {
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.machine.state !== "sleep") return;
      // The user is back at the computer: wake up gently.
      if (this.systemIdleSeconds() < 3) {
        this.lastInteraction = this.now();
        this.machine.send("WAKE");
      } else {
        this.scheduleSleepPoll();
      }
    }, SLEEP_POLL_MS);
  }

  private beginWalk(): void {
    const size = this.port.getSize();
    const pos = this.port.getPosition();
    const area = findContainingArea({ ...pos, ...size }, this.port.workAreas()) ?? this.port.workAreaNear(pos);
    const bounds = computeBounds(area, size);
    const target = pickWanderTarget(pos.x, bounds, this.rng);
    if (target === null) {
      // Nowhere to go; defer so we don't transition re-entrantly.
      this.stateTimer = setTimeout(() => this.machine.send("ARRIVED"), 0);
      return;
    }
    this.walkTarget = target;
    this.walkX = pos.x;
    this.facing = target < pos.x ? "left" : "right";
    this.publishView();
    this.lastTick = this.now();
    this.walkTimer = setInterval(() => this.walkTick(), WALK_TICK_MS);
  }

  private walkTick(): void {
    if (this.walkTarget === null || this.dragging) {
      this.machine.send("ARRIVED");
      return;
    }
    const t = this.now();
    const dt = Math.min(100, t - this.lastTick);
    this.lastTick = t;
    const step = stepToward(this.walkX, this.walkTarget, MOVEMENT_SPEEDS[this.settings.movementSpeed], dt);
    this.walkX = step.x;
    const pos = this.port.getPosition();
    this.port.setPosition({ x: Math.round(step.x), y: pos.y });
    if (step.arrived) this.machine.send("ARRIVED");
  }

  private stopWalking(): void {
    if (this.walkTimer) clearInterval(this.walkTimer);
    this.walkTimer = null;
    this.walkTarget = null;
  }

  private scheduleAmbient(): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
    if (this.paused || !this.settings.ambientComments) return;
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null;
      // Only speak up when the user is actively at the computer and the companion is visible and idle.
      if (this.port.isVisible() && this.systemIdleSeconds() < 60) this.sayAmbient(this.ambientLine());
      this.scheduleAmbient();
    }, randomBetween(this.rng, AMBIENT_MIN_MS, AMBIENT_MAX_MS));
  }
}
