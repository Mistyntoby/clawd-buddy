import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bubbleText, CompanionController, speechDuration, type CompanionPort } from "../src/main/companion-controller";
import { IDLE_MAX_MS, IDLE_MIN_MS, MOTION, ONE_SHOT_MS } from "../src/shared/constants";
import type { Point, Rect } from "../src/shared/movement";
import type { CompanionView, SpeechPayload } from "../src/shared/types";

class FakePort implements CompanionPort {
  pos: Point = { x: 800, y: 772 };
  size = { width: 280, height: 268 };
  /** The body inside the window; the rest of the window is transparent. */
  body: Rect = { x: 100, y: 180, width: 80, height: 60 };
  cursor: Point = { x: 0, y: 0 };
  moves = 0;
  visible = true;
  areas: Rect[] = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  views: CompanionView[] = [];
  speech: (SpeechPayload | null)[] = [];
  sounds: string[] = [];
  getPosition = () => ({ ...this.pos });
  setPosition = (p: Point) => {
    this.moves++;
    this.pos = { x: p.x, y: p.y };
  };
  getSize = () => this.size;
  bodyRect = () => ({ ...this.body });
  cursorPoint = () => ({ ...this.cursor });
  isVisible = () => this.visible;
  workAreas = () => this.areas;
  workAreaNear = () => this.areas[0]!;
  sendView = (v: CompanionView) => void this.views.push(v);
  sendSpeech = (s: SpeechPayload | null) => void this.speech.push(s);
  sendSound = (s: string) => void this.sounds.push(s);
}

const settings = { wandering: true, movementSpeed: "fast" as const, idleChatter: "off" as const, animationIntensity: "normal" as const };

let now = 0;
beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
});
afterEach(() => vi.useRealTimers());

function make(port = new FakePort(), rngValue = 0.1) {
  const c = new CompanionController(port, settings, () => "hi", {
    rng: () => rngValue,
    now: () => now,
    systemIdleSeconds: () => 0,
  });
  return { c, port };
}

function advanceUntil(done: () => boolean, maxMs: number) {
  for (let t = 0; t < maxMs && !done(); t += 33) {
    now += 33;
    vi.advanceTimersByTime(33);
  }
}

function advance(ms: number) {
  for (let t = 0; t < ms; t += 33) {
    now += 33;
    vi.advanceTimersByTime(33);
  }
}

describe("companion controller", () => {
  it("wanders, stays on screen, faces its direction, and returns to idle", () => {
    const { c, port } = make();
    c.start();
    advanceUntil(() => c.state === "walk", IDLE_MAX_MS + 1000);
    expect(c.state).toBe("walk");
    advanceUntil(() => c.state === "idle", 20_000);
    expect(c.state).toBe("idle");
    expect(port.pos.x).toBeGreaterThanOrEqual(0);
    expect(port.pos.x).toBeLessThanOrEqual(1920 - 280);
    expect(port.pos.y).toBe(772);
    expect(port.views.find((v) => v.animation === "walk")?.facing).toBeDefined();
    c.dispose();
  });

  it("does not wander when wandering is disabled", () => {
    const { c, port } = make();
    c.updateSettings({ ...settings, wandering: false });
    c.start();
    advance(60_000);
    expect(port.views.some((v) => v.animation === "walk")).toBe(false);
    expect(port.pos.x).toBe(800);
    c.dispose();
  });

  it("speech shows the talk animation, then returns to idle", () => {
    const { c, port } = make();
    c.start();
    c.say("Hello there!", "offline");
    expect(c.state).toBe("talk");
    expect(port.speech.at(-1)).toMatchObject({ text: "Hello there!", source: "offline" });
    vi.advanceTimersByTime(speechDuration("Hello there!") + 10);
    expect(c.state).toBe("idle");
    expect(port.speech.at(-1)).toBeNull();
    c.dispose();
  });

  it("chat flow: think → talk with streaming bubble → idle", () => {
    const { c, port } = make();
    c.start();
    c.chatThinking();
    expect(c.state).toBe("think");
    c.chatFirstToken();
    c.chatDelta("Hi ");
    c.chatDelta("friend");
    expect(c.state).toBe("talk");
    expect(port.speech.at(-1)).toMatchObject({ text: "Hi friend", streaming: true, source: "claude" });
    c.chatDone("Hi friend", "claude");
    vi.advanceTimersByTime(speechDuration("Hi friend") + 10);
    expect(c.state).toBe("idle");
    c.dispose();
  });

  it("errors show the confused animation, then recover", () => {
    const { c } = make();
    c.start();
    c.chatThinking();
    c.chatError("Network down");
    expect(c.state).toBe("confused");
    vi.advanceTimersByTime(ONE_SHOT_MS.confused + 10);
    expect(c.state).toBe("idle");
    c.dispose();
  });

  it("recovers when its monitor disappears", () => {
    const { c, port } = make();
    port.pos = { x: 3000, y: 300 };
    const p = c.ensureOnScreen();
    expect(p.x + port.body.x + port.body.width).toBeLessThanOrEqual(1920);
    expect(port.pos).toEqual(p);
  });

  it("pause() leaves no timers running (no runaway loops)", () => {
    const { c } = make();
    c.start();
    advance(IDLE_MAX_MS + 100); // mid-walk
    c.pause();
    c.dismissSpeech();
    expect(vi.getTimerCount()).toBe(0);
    c.dispose();
  });

  it("poke wakes a sleeping companion", () => {
    const { c } = make();
    c.start();
    c.machine.send("SLEEP");
    c.poke();
    expect(c.state).toBe("wake");
    c.dispose();
  });
});

describe("dragging and dropping", () => {
  /** Press on Clawd with the cursor `offset` px inside the window, move to `to`, release. */
  function drag(c: CompanionController, port: FakePort, to: Point, offset: Point = { x: 140, y: 210 }) {
    port.cursor = { x: port.pos.x + offset.x, y: port.pos.y + offset.y };
    c.grab();
    c.dragStart();
    // Move in a few steps, like a real pointer.
    const from = port.cursor;
    for (let i = 1; i <= 5; i++) {
      port.cursor = { x: from.x + ((to.x - from.x) * i) / 5, y: from.y + ((to.y - from.y) * i) / 5 };
      advance(16);
      c.dragMove();
    }
    return c.release();
  }

  it("grabbing interrupts wandering immediately", () => {
    const { c, port } = make();
    c.start();
    advanceUntil(() => c.state === "walk", IDLE_MAX_MS + 1000);
    advance(300);
    expect(c.state).toBe("walk");
    port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
    c.grab();
    expect(c.state).toBe("idle");
    const frozen = { ...port.pos };
    advance(2000);
    expect(port.pos).toEqual(frozen); // no stale walk tick moved the window
    c.release();
    c.dispose();
  });

  it("follows the cursor with the original grab offset (no jump under the cursor)", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: 950, y: 990 }; // 150, 218 inside the window at 800, 772
    c.grab();
    c.dragStart();
    port.cursor = { x: 600, y: 500 };
    c.dragMove(); // event-driven: each pointer event moves the window right away
    expect(port.pos).toEqual({ x: 450, y: 282 });
    c.release();
    c.dispose();
  });

  it("moves on every pointer event without a frame-rate cap or a queue", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: 950, y: 990 };
    c.grab();
    c.dragStart();
    const moves = port.moves;
    // 240 pointer events with no time passing at all (e.g. a 240 Hz display): every one is applied.
    for (let i = 1; i <= 240; i++) {
      port.cursor = { x: 950 + i, y: 990 };
      c.dragMove();
    }
    expect(port.moves - moves).toBe(240);
    expect(port.pos).toEqual({ x: 1040, y: 772 });
    // Duplicate events for an unchanged cursor don't cause redundant window moves.
    c.dragMove();
    c.dragMove();
    expect(port.moves - moves).toBe(240);
    c.release();
    c.dispose();
  });

  it("catches up via the watchdog if pointer events stop arriving mid-drag", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: 950, y: 990 };
    c.grab();
    c.dragStart();
    port.cursor = { x: 700, y: 600 }; // the pointer left the window and no events came
    advance(150);
    expect(port.pos).toEqual({ x: 550, y: 382 });
    c.release();
    c.dispose();
  });

  it("a release that is never reported ends the hold automatically (never stuck dragging)", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: 950, y: 990 };
    c.grab();
    c.dragStart();
    port.cursor = { x: 500, y: 500 };
    c.dragMove();
    advance(MOTION.drag.staleReleaseMs + 300);
    expect(c.isHeld).toBe(false);
    expect(c.state === "land" || c.state === "idle").toBe(true);
    expect(port.pos).toEqual({ x: 350, y: 282 });
    c.dispose();
  });

  it("drags work repeatedly, and a new press recovers from a lost release", () => {
    const { c, port } = make();
    c.start();
    for (const [x, y] of [[300, 300], [1200, 500], [600, 900], [100, 100], [1700, 200]] as const) {
      port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
      c.grab();
      c.dragStart();
      port.cursor = { x, y };
      c.dragMove();
      expect(c.release()).toEqual({ x: x - 140, y: y - 210 });
      advance(ONE_SHOT_MS.land + 50);
    }
    // Press, drag, and the release never arrives; the next press starts cleanly anyway.
    port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
    c.grab();
    c.dragStart();
    port.cursor = { x: 800, y: 800 };
    c.dragMove();
    port.cursor = { x: 800, y: 800 };
    c.grab(); // fresh press
    c.dragStart();
    port.cursor = { x: 900, y: 700 };
    c.dragMove();
    expect(c.release()).toEqual({ x: 760, y: 490 });
    c.dispose();
  });

  it("leaves the window exactly where it was released", () => {
    const { c, port } = make();
    c.start();
    const final = drag(c, port, { x: 400, y: 300 });
    expect(final).toEqual({ x: 260, y: 90 });
    expect(port.pos).toEqual({ x: 260, y: 90 });
    c.dispose();
  });

  it("the landing animation never moves the window, and idle/wandering can't cut it short", () => {
    const { c, port } = make();
    c.start();
    drag(c, port, { x: 400, y: 300 });
    expect(c.state).toBe("land");
    const moves = port.moves;
    advance(ONE_SHOT_MS.land - 50);
    expect(c.state).toBe("land");
    advance(100);
    expect(c.state).toBe("idle");
    expect(port.moves).toBe(moves);
    expect(port.pos).toEqual({ x: 260, y: 90 });
    c.dispose();
  });

  it("wandering resumes only after landing, and only from the drop position", () => {
    const { c, port } = make();
    c.start();
    drag(c, port, { x: 400, y: 300 });
    advance(ONE_SHOT_MS.land + 50);
    expect(c.state).toBe("idle");
    advance(IDLE_MIN_MS - 500);
    expect(port.pos).toEqual({ x: 260, y: 90 }); // no immediate walk, no stale target
    advance(IDLE_MAX_MS);
    expect(port.views.some((v) => v.animation === "walk")).toBe(true);
    expect(port.pos.y).toBe(90); // walks along the new spot, never back to the old one
    c.dispose();
  });

  it("with wandering disabled, the drop position holds indefinitely", () => {
    const { c, port } = make();
    c.updateSettings({ ...settings, wandering: false });
    c.start();
    drag(c, port, { x: 1500, y: 600 });
    const at = { ...port.pos };
    advance(120_000);
    expect(port.pos).toEqual(at);
    c.dispose();
  });

  it("works while talking or thinking, and the conversation resumes after landing", () => {
    const { c, port } = make();
    c.start();
    c.chatThinking();
    port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
    c.grab();
    c.dragStart();
    expect(c.state).toBe("pickup");
    c.chatFirstToken(); // reply starts streaming while Clawd is in the air
    expect(c.state).not.toBe("talk");
    advance(ONE_SHOT_MS.pickup + 50);
    expect(c.state).toBe("drag");
    c.release();
    advance(ONE_SHOT_MS.land + 50);
    expect(c.state).toBe("talk");
    c.dispose();
  });

  it("an error while held shows the confused reaction after landing, never a success", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
    c.grab();
    c.dragStart();
    c.chatError("Network down");
    expect(c.state).toBe("pickup");
    c.release();
    advance(ONE_SHOT_MS.land + 50);
    expect(c.state).toBe("confused");
    c.dispose();
  });

  it("a click (press and release without moving) is not a drop", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: 900, y: 950 };
    c.grab();
    const moves = port.moves;
    expect(c.release()).toBeNull();
    expect(c.state).toBe("idle");
    expect(port.moves).toBe(moves);
    c.dispose();
  });

  it("keeps the body on screen but lets the transparent margin hang off the edge", () => {
    const { c, port } = make();
    c.start();
    // Window left edge at -60: the body (x 100..180 inside the window) is still fully visible.
    const ok = drag(c, port, { x: -60 + 140, y: 500 });
    expect(ok).toEqual({ x: -60, y: 290 });
    // Body partly off the left edge: pushed just far enough.
    const pushed = drag(c, port, { x: -150 + 140, y: 500 });
    expect(pushed).toEqual({ x: -100, y: 290 });
    c.dispose();
  });

  it("drops onto a second monitor with negative coordinates exactly", () => {
    const { c, port } = make();
    port.areas = [
      { x: 0, y: 0, width: 1920, height: 1040 },
      { x: -2560, y: -300, width: 2560, height: 1400 },
    ];
    c.start();
    const final = drag(c, port, { x: -1200, y: 100 });
    expect(final).toEqual({ x: -1340, y: -110 });
    c.dispose();
  });

  it("hiding mid-drag stops the drag follower (no orphaned interval)", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
    c.grab();
    c.dragStart();
    c.pause();
    c.dismissSpeech();
    expect(vi.getTimerCount()).toBe(0);
    c.dispose();
  });

  it("display changes during a drag don't fight the user", () => {
    const { c, port } = make();
    c.start();
    port.cursor = { x: port.pos.x + 140, y: port.pos.y + 210 };
    c.grab();
    c.dragStart();
    port.cursor = { x: 5000, y: 5000 };
    advance(40);
    const held = { ...port.pos };
    c.ensureOnScreen();
    expect(port.pos).toEqual(held);
    c.release();
    c.dispose();
  });
});

describe("speech helpers", () => {
  it("truncates long bubble text and points to the chat", () => {
    const t = bubbleText("a".repeat(500));
    expect(t.length).toBeLessThan(300);
    expect(t).toMatch(/see chat/);
    expect(bubbleText(" short ")).toBe("short");
  });
  it("scales display time with length, within limits", () => {
    expect(speechDuration("hi")).toBe(4000);
    expect(speechDuration("x".repeat(10_000))).toBe(16000);
  });
});
