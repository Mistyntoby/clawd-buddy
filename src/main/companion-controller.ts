import { BehaviorMachine, isHeld, ONE_SHOT_STATES, type BehaviorEvent, type BehaviorState } from "../shared/behavior";
import {
  AMBIENT_MAX_MS,
  AMBIENT_MIN_MS,
  CHATTY_MAX_MS,
  CHATTY_MIN_MS,
  IDLE_MAX_MS,
  IDLE_MIN_MS,
  MOTION,
  MOVEMENT_SPEEDS,
  ONE_SHOT_MAX_MS,
  ONE_SHOT_MS,
  SLEEP_AFTER_MS,
  WALK_TICK_MS,
} from "../shared/constants";
import {
  boundsForBody,
  clampPosition,
  defaultPosition,
  dropPosition,
  findContainingArea,
  pickWanderTarget,
  randomBetween,
  stepWalk,
  type Point,
  type Rect,
  type Rng,
  type Size,
  type WalkState,
} from "../shared/movement";
import type { AnimationIntensity, AnimationName, CompanionView, Facing, IdleChatter, MovementSpeed, SpeechPayload } from "../shared/types";

/** The slice of the companion window the controller needs. Implemented by WindowManager. */
export interface CompanionPort {
  getPosition(): Point;
  /** The only way the companion window is ever moved. */
  setPosition(p: Point): void;
  getSize(): Size;
  /** Clawd's standing body inside the window (window-relative CSS px). */
  bodyRect(): Rect;
  isVisible(): boolean;
  /** Work areas of all connected displays (what the OS reports). */
  workAreas(): Rect[];
  /** Area for default placement near a point (keeps clear of an auto-hide taskbar). */
  workAreaNear(p: Point): Rect;
  /** Current mouse position in the same coordinate space as window positions (DIP). */
  cursorPoint(): Point;
  sendView(view: CompanionView): void;
  sendSpeech(speech: SpeechPayload | null): void;
  sendSound(sound: "pop" | "chime" | "blip" | "error"): void;
}

export interface ControllerOptions {
  rng?: Rng;
  /** Seconds since the user last used mouse/keyboard anywhere (OS-level). */
  systemIdleSeconds?: () => number;
  now?: () => number;
  /**
   * Picks which variant of an animation to play in the active sprite pack and
   * how long it plays once (ms, or null if unknown).
   */
  chooseAnimation?: (name: AnimationName, rng: Rng) => { variant: number; durationMs: number | null };
  /** Called once after every drop with the final window position (e.g. to save it). */
  onDrop?: (position: Point) => void;
}

export interface ControllerSettings {
  wandering: boolean;
  movementSpeed: MovementSpeed;
  idleChatter: IdleChatter;
  animationIntensity: AnimationIntensity;
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

type ChatPhase = "none" | "thinking" | "talking";

/**
 * Owns Clawd's behavior and is the single authority over the companion
 * window's position.
 *
 * Window movement has exactly two sources, and they never run together:
 *  - the drag follower (while the user holds Clawd), and
 *  - the walk ticker (while wandering).
 * Grabbing Clawd stops the walk ticker before anything else happens, and the
 * walk ticker, idle decisions, and display-change corrections all check the
 * hold flag. On release, the final position is computed once from the real
 * cursor position and applied once.
 *
 * Timers: one state timer (idle decision / one-shot end / sleep poll), one
 * walk interval, one drag interval, one speech timer, one ambient timer. Each
 * is cleared before it is re-armed.
 */
export class CompanionController {
  readonly machine = new BehaviorMachine();
  private facing: Facing = "right";
  private viewSeq = 0;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private walkTimer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastPointerEvent = 0;
  private dragStats = { moves: 0, startedAt: 0 };
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private ambientTimer: ReturnType<typeof setTimeout> | null = null;
  private walkTarget: number | null = null;
  private walk: WalkState = { x: 0, v: 0 };
  private walkY = 0;
  private legsLeft = 0;
  private lastTick = 0;
  /** Set from pointer-down until release: Clawd is in the user's hand (or about to be). */
  private grabbed = false;
  private dragging = false;
  private grabOffset: Point = { x: 0, y: 0 };
  private lastDragPos: Point | null = null;
  private paused = false;
  private lastInteraction: number;
  private streamingText = "";
  private chatPhase: ChatPhase = "none";
  /** A reaction that arrived while Clawd was held; shown after landing. */
  private pendingError = false;
  private readonly rng: Rng;
  private readonly systemIdleSeconds: () => number;
  private readonly now: () => number;
  private readonly chooseAnimation: (name: AnimationName, rng: Rng) => { variant: number; durationMs: number | null };
  private readonly onDrop: (position: Point) => void;
  private variant = 0;
  /** Set by perform(): the variant the next state change must use. */
  private forcedVariant: number | null = null;
  private lastPet = -Infinity;
  private variantDurationMs: number | null = null;

  constructor(
    private readonly port: CompanionPort,
    private settings: ControllerSettings,
    private readonly ambientLine: () => string,
    opts: ControllerOptions = {},
  ) {
    this.rng = opts.rng ?? Math.random;
    this.systemIdleSeconds = opts.systemIdleSeconds ?? (() => 0);
    this.now = opts.now ?? Date.now;
    this.chooseAnimation = opts.chooseAnimation ?? (() => ({ variant: 0, durationMs: null }));
    this.onDrop = opts.onDrop ?? (() => {});
    this.lastInteraction = this.now();
    this.machine.onChange((next, prev, event) => this.onStateChange(next, prev, event));
  }

  get state(): BehaviorState {
    return this.machine.state;
  }

  /** True from pointer-down until release. */
  get isHeld(): boolean {
    return this.grabbed;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  get view(): CompanionView {
    return { animation: this.machine.state, facing: this.facing, seq: this.viewSeq, variant: this.variant };
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
    this.stopWatchdog();
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.machine.state === "walk") this.machine.send("ARRIVED");
    if (isHeld(this.machine.state)) {
      // The window was hidden mid-drag; there is no drop to animate.
      this.grabbed = false;
      this.dragging = false;
      this.machine.send("RESET");
    }
    this.scheduleIdle();
    this.scheduleAmbient();
    this.publishView();
  }

  dispose(): void {
    this.pause();
    this.clearSpeechTimer();
  }

  updateSettings(s: ControllerSettings): void {
    const wanderingTurnedOff = this.settings.wandering && !s.wandering;
    this.settings = s;
    if (wanderingTurnedOff) {
      this.legsLeft = 0;
      if (this.machine.state === "walk") this.machine.send("ARRIVED");
    }
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

  /**
   * Petting (rubbing the pointer over Clawd, or the menu). Has a cooldown so a
   * long rub or repeated clicks don't spam reactions. Returns true if he reacted.
   */
  pet(): boolean {
    const t = this.now();
    if (t - this.lastPet < MOTION.petCooldownMs) return false;
    const wasAsleep = this.machine.state === "sleep";
    this.noteInteraction();
    if (wasAsleep) return true;
    if (!this.machine.send("REACT_HAPPY")) return false;
    this.lastPet = t;
    this.port.sendSound("pop");
    return true;
  }

  /** Lightbulb moment, e.g. for a fun fact. */
  idea(): void {
    this.noteInteraction();
    this.machine.send("IDEA");
  }

  /**
   * Plays a specific animation variant on request (the "Do a trick" menu).
   * The variant index is an index into the sprite pack's sequences for that state.
   */
  perform(state: "happy" | "action" | "wave" | "idea" | "idle-variation", variant: number): boolean {
    this.noteInteraction();
    const event = { happy: "REACT_HAPPY", action: "FIDGET", wave: "WAVE", idea: "IDEA", "idle-variation": "IDLE_VARIATION" } as const;
    if (this.machine.state === state) this.machine.send("RESET");
    this.forcedVariant = Math.max(0, Math.floor(variant));
    const ok = this.machine.send(event[state]);
    this.forcedVariant = null;
    return ok;
  }

  /** A friendly wave, e.g. when the chat window opens. */
  wave(): void {
    this.noteInteraction();
    this.machine.send("WAVE");
  }

  /** Short celebration for an operation that actually succeeded. */
  celebrate(): void {
    this.noteInteraction();
    if (this.machine.send("REACT_HAPPY")) this.port.sendSound("chime");
  }

  /** Short "oops" for an operation that actually failed. */
  flinch(): void {
    this.noteInteraction();
    if (isHeld(this.machine.state)) this.pendingError = true;
    else this.machine.send("ERROR");
  }

  // ---- holding and dragging -------------------------------------------------

  /**
   * Pointer pressed on Clawd. Movement stops immediately and the cursor-to-
   * window offset is recorded from the OS cursor position, in the same
   * coordinate space as the window position.
   */
  grab(): void {
    // A new press always starts a fresh hold, even if an earlier release was never reported.
    if (this.grabbed) this.release();
    this.noteInteraction();
    this.grabbed = true;
    this.legsLeft = 0;
    if (this.machine.state === "walk") this.machine.send("ARRIVED");
    this.stopWalking();
    this.clearStateTimer();
    const pos = this.port.getPosition();
    const cursor = this.port.cursorPoint();
    this.grabOffset = { x: cursor.x - pos.x, y: cursor.y - pos.y };
    this.lastPointerEvent = this.now();
    this.startWatchdog();
  }

  /** The press turned into a drag: pick Clawd up; the window now follows the cursor. */
  dragStart(): void {
    if (!this.grabbed) this.grab();
    if (this.dragging) return;
    this.dragging = true;
    this.dragStats = { moves: 0, startedAt: this.now() };
    this.lastDragPos = this.port.getPosition();
    this.machine.send("DRAG_START");
    this.followCursor();
  }

  /**
   * The pointer moved during a drag (event-driven: called once per pointer
   * event the renderer receives, which Chromium already coalesces to the
   * display's refresh rate). The window jumps straight to the latest OS cursor
   * position: there is no queue of stale positions and no fixed-rate timer.
   */
  dragMove(): void {
    if (!this.dragging) return;
    this.lastPointerEvent = this.now();
    this.followCursor();
  }

  /** Movement counters for the current/last drag, for diagnostics and tests. */
  get lastDragStats(): { moves: number; durationMs: number } {
    return { moves: this.dragStats.moves, durationMs: this.now() - this.dragStats.startedAt };
  }

  private followCursor(): void {
    if (!this.dragging) return;
    const c = this.port.cursorPoint();
    const next = { x: Math.round(c.x - this.grabOffset.x), y: Math.round(c.y - this.grabOffset.y) };
    if (this.lastDragPos && next.x === this.lastDragPos.x && next.y === this.lastDragPos.y) return;
    this.lastDragPos = next;
    this.dragStats.moves++;
    this.port.setPosition(next);
  }

  /**
   * Safety net only, not the movement path: catches up if pointer events
   * stop arriving mid-drag, and ends a hold whose release was never reported
   * (e.g. the button came up over another app), so Clawd can't get stuck.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.grabbed) return this.stopWatchdog();
      if (this.dragging) this.followCursor();
      if (this.now() - this.lastPointerEvent > MOTION.drag.staleReleaseMs) this.release();
    }, MOTION.drag.watchdogMs);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Pointer released (or the press was cancelled). After a drag, the window
   * is placed exactly where the cursor left it (moved only if Clawd's body
   * would otherwise be off every display), then Clawd plays its landing.
   * Returns the final position after a drag, or null for a plain click.
   */
  release(): Point | null {
    const wasDragging = this.dragging;
    const wasGrabbed = this.grabbed;
    this.stopWatchdog();
    this.grabbed = false;
    this.dragging = false;
    if (!wasDragging) {
      if (wasGrabbed && this.machine.state === "idle") this.scheduleIdle();
      return null;
    }
    const c = this.port.cursorPoint();
    const release = { x: Math.round(c.x - this.grabOffset.x), y: Math.round(c.y - this.grabOffset.y) };
    const final = dropPosition(release, this.port.bodyRect(), this.port.workAreas());
    this.port.setPosition(final);
    this.lastDragPos = null;
    this.machine.send("DROP");
    this.onDrop(final);
    return final;
  }

  /**
   * Makes sure Clawd's body is on some display. Used at startup and when
   * displays change; never while Clawd is held. Returns the position.
   */
  ensureOnScreen(preferred?: Point | null): Point {
    const cur = this.port.getPosition();
    if (this.grabbed) return cur;
    const body = this.port.bodyRect();
    const pos = preferred ?? cur;
    const bodyRect = { x: pos.x + body.x, y: pos.y + body.y, width: body.width, height: body.height };
    const area = findContainingArea(bodyRect, this.port.workAreas());
    const next = area ? clampPosition(pos, boundsForBody(area, body)) : defaultPosition(this.port.workAreaNear(pos), this.port.getSize());
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

  /** Unprompted remark: only when idle; silent in quiet mode. */
  sayAmbient(text: string): boolean {
    if (this.machine.state !== "idle" || this.settings.idleChatter === "off") return false;
    this.say(text, "offline", { sound: this.settings.idleChatter === "chatty" });
    return true;
  }

  chatThinking(): void {
    this.noteInteraction();
    this.clearSpeechTimer();
    this.streamingText = "";
    this.chatPhase = "thinking";
    this.machine.send("CHAT_START");
    this.port.sendSpeech({ text: "…", source: "system", streaming: true });
  }

  chatFirstToken(): void {
    this.chatPhase = "talking";
    this.machine.send("FIRST_TOKEN");
    this.port.sendSound("blip");
  }

  chatDelta(text: string): void {
    this.streamingText += text;
    if (this.chatPhase === "talking") {
      const tail = this.streamingText.length > BUBBLE_MAX_CHARS ? `…${this.streamingText.slice(-BUBBLE_MAX_CHARS)}` : this.streamingText;
      this.port.sendSpeech({ text: tail, source: "claude", streaming: true });
    }
  }

  chatDone(text: string, source: "claude" | "offline"): void {
    this.chatPhase = "none";
    this.say(text, source, { sound: false });
  }

  chatError(message: string): void {
    this.clearSpeechTimer();
    this.streamingText = "";
    this.chatPhase = "none";
    if (isHeld(this.machine.state)) this.pendingError = true;
    else this.machine.send("ERROR");
    this.port.sendSpeech({ text: message, source: "system", durationMs: speechDuration(message) });
    this.port.sendSound("error");
    this.speechTimer = setTimeout(() => this.port.sendSpeech(null), speechDuration(message));
  }

  chatCancelled(): void {
    this.clearSpeechTimer();
    this.streamingText = "";
    this.chatPhase = "none";
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

  private onStateChange(next: BehaviorState, prev: BehaviorState, event: BehaviorEvent): void {
    this.clearStateTimer();
    if (prev === "walk") this.stopWalking();
    this.viewSeq++;
    const choice = this.chooseAnimation(next, this.forcedVariant !== null ? () => this.forcedVariant as number : this.rng);
    this.forcedVariant = null;
    this.variant = choice.variant;
    this.variantDurationMs = choice.durationMs;
    this.publishView();
    if (this.paused) return;

    if (next === "idle" && event === "LANDED") {
      // Whatever happened while Clawd was in the air resumes now.
      if (this.resumeAfterLanding()) return;
    }

    switch (next) {
      case "idle":
        this.scheduleIdle(this.legsLeft > 0 ? randomBetween(this.rng, MOTION.walk.pauseMinMs, MOTION.walk.pauseMaxMs) : undefined);
        break;
      case "walk":
        this.beginWalk();
        break;
      case "pickup":
        this.stateTimer = setTimeout(() => this.machine.send("PICKED_UP"), this.oneShotMs("pickup"));
        break;
      case "land":
        this.stateTimer = setTimeout(() => this.machine.send("LANDED"), this.oneShotMs("land"));
        break;
      case "sleep":
        this.scheduleSleepPoll();
        break;
      default:
        if (ONE_SHOT_STATES.has(next)) this.stateTimer = setTimeout(() => this.machine.send("ONE_SHOT_END"), this.oneShotMs(next));
        break;
    }
  }

  /** Returns true if it moved on to a pending state. */
  private resumeAfterLanding(): boolean {
    if (this.pendingError) {
      this.pendingError = false;
      return this.machine.send("ERROR");
    }
    if (this.chatPhase === "thinking") return this.machine.send("CHAT_START");
    if (this.chatPhase === "talking" || this.speechTimer) return this.machine.send("SPEAK");
    return false;
  }

  private oneShotMs(state: AnimationName): number {
    const fromPack = state === this.machine.state ? this.variantDurationMs : null;
    const fallback = (ONE_SHOT_MS as Record<string, number>)[state] ?? 1500;
    const ms = fromPack !== null && fromPack > 0 ? fromPack : fallback;
    return Math.min(ONE_SHOT_MAX_MS, ms);
  }

  private publishView(): void {
    this.port.sendView(this.view);
  }

  private clearStateTimer(): void {
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
  }

  /** Schedules the next autonomous decision while idle. Exactly one timer at a time. */
  private scheduleIdle(delayMs?: number): void {
    this.clearStateTimer();
    if (this.paused || this.grabbed || this.machine.state !== "idle") return;
    const scale = MOTION.intensity[this.settings.animationIntensity].idleScale;
    this.stateTimer = setTimeout(() => this.decide(), delayMs ?? Math.round(randomBetween(this.rng, IDLE_MIN_MS, IDLE_MAX_MS) * scale));
  }

  private decide(): void {
    this.stateTimer = null;
    if (this.paused || this.grabbed || this.machine.state !== "idle" || !this.port.isVisible()) {
      this.scheduleIdle();
      return;
    }
    if (this.legsLeft > 0 && this.settings.wandering) {
      this.machine.send("WANDER_START");
      return;
    }
    this.legsLeft = 0;
    const inactiveMs = this.now() - this.lastInteraction;
    if (inactiveMs >= SLEEP_AFTER_MS && this.systemIdleSeconds() >= 120) {
      this.machine.send("SLEEP");
      return;
    }
    const roll = this.rng();
    const extras = MOTION.intensity[this.settings.animationIntensity].extras;
    const { wander } = MOTION.idle;
    const variation = MOTION.idle.variation * extras;
    const fidget = MOTION.idle.fidget * extras;
    if (this.settings.wandering && roll < wander) {
      this.legsLeft = randomBetween(this.rng, MOTION.walk.legsMin, MOTION.walk.legsMax);
      this.machine.send("WANDER_START");
    } else if (roll < wander + variation) {
      this.machine.send("IDLE_VARIATION");
    } else if (roll < wander + variation + fidget) {
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
    this.legsLeft = Math.max(0, this.legsLeft - 1);
    const pos = this.port.getPosition();
    const body = this.port.bodyRect();
    const bodyRect = { x: pos.x + body.x, y: pos.y + body.y, width: body.width, height: body.height };
    const area = findContainingArea(bodyRect, this.port.workAreas()) ?? this.port.workAreaNear(pos);
    const bounds = boundsForBody(area, body);
    const target = pickWanderTarget(pos.x, bounds, this.rng);
    if (target === null) {
      // Nowhere to go; defer so we don't transition re-entrantly.
      this.legsLeft = 0;
      this.stateTimer = setTimeout(() => this.machine.send("ARRIVED"), 0);
      return;
    }
    this.walkTarget = target;
    this.walk = { x: pos.x, v: 0 };
    this.walkY = pos.y;
    this.facing = target < pos.x ? "left" : "right";
    this.publishView();
    this.lastTick = this.now();
    this.walkTimer = setInterval(() => this.walkTick(), WALK_TICK_MS);
  }

  private walkTick(): void {
    if (this.walkTarget === null || this.grabbed) {
      this.stopWalking();
      if (this.machine.state === "walk") this.machine.send("ARRIVED");
      return;
    }
    const t = this.now();
    const dt = Math.min(100, t - this.lastTick);
    this.lastTick = t;
    const step = stepWalk(this.walk, this.walkTarget, MOVEMENT_SPEEDS[this.settings.movementSpeed], MOTION.walk.accel, dt);
    const moved = Math.round(step.x) !== Math.round(this.walk.x);
    this.walk = { x: step.x, v: step.v };
    if (moved || step.arrived) this.port.setPosition({ x: Math.round(step.x), y: this.walkY });
    if (step.arrived) {
      this.stopWalking();
      this.machine.send("ARRIVED");
    }
  }

  private stopWalking(): void {
    if (this.walkTimer) clearInterval(this.walkTimer);
    this.walkTimer = null;
    this.walkTarget = null;
  }

  private scheduleAmbient(): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
    if (this.paused || this.settings.idleChatter === "off") return;
    const [min, max] = this.settings.idleChatter === "chatty" ? [CHATTY_MIN_MS, CHATTY_MAX_MS] : [AMBIENT_MIN_MS, AMBIENT_MAX_MS];
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null;
      // Only speak up when the user is actively at the computer and the companion is visible and idle.
      if (this.port.isVisible() && this.systemIdleSeconds() < 60) this.sayAmbient(this.ambientLine());
      this.scheduleAmbient();
    }, randomBetween(this.rng, min, max));
  }
}
