import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bubbleText, CompanionController, speechDuration, type CompanionPort } from "../src/main/companion-controller";
import { IDLE_MAX_MS, ONE_SHOT_MS } from "../src/shared/constants";
import type { Point, Rect } from "../src/shared/movement";
import type { CompanionView, SpeechPayload } from "../src/shared/types";

class FakePort implements CompanionPort {
  pos: Point = { x: 800, y: 772 };
  size = { width: 280, height: 268 };
  visible = true;
  areas: Rect[] = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  views: CompanionView[] = [];
  speech: (SpeechPayload | null)[] = [];
  sounds: string[] = [];
  getPosition = () => ({ ...this.pos });
  setPosition = (p: Point) => {
    this.pos = { x: p.x, y: p.y };
  };
  getSize = () => this.size;
  isVisible = () => this.visible;
  workAreas = () => this.areas;
  workAreaNear = () => this.areas[0]!;
  sendView = (v: CompanionView) => void this.views.push(v);
  sendSpeech = (s: SpeechPayload | null) => void this.speech.push(s);
  sendSound = (s: string) => void this.sounds.push(s);
}

const settings = { wandering: true, movementSpeed: "fast" as const, ambientComments: false };

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
    advance(IDLE_MAX_MS + 100);
    expect(port.views.some((v) => v.animation === "walk")).toBe(true);
    advance(20_000);
    expect(c.state).not.toBe("walk");
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

  it("drag stops walking and snaps the window back on screen", () => {
    const { c, port } = make();
    c.start();
    c.dragStart({ x: 900, y: 900 });
    c.dragMove({ x: 5000, y: 5000 });
    expect(port.pos.x).toBeGreaterThan(1920);
    const final = c.dragEnd();
    expect(final.x).toBeLessThanOrEqual(1920 - 280);
    expect(final.y).toBeLessThanOrEqual(1040 - 268);
    c.dispose();
  });

  it("recovers when its monitor disappears", () => {
    const { c, port } = make();
    port.pos = { x: 3000, y: 300 };
    const p = c.ensureOnScreen();
    expect(p.x).toBeLessThanOrEqual(1920 - 280);
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
