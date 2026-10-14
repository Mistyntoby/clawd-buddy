import { describe, expect, it } from "vitest";
import { BehaviorMachine, isBusy, isHeld, STATE_PRIORITY, transition, type BehaviorEvent } from "../src/shared/behavior";
import { ANIMATION_NAMES } from "../src/shared/types";

describe("behavior state machine", () => {
  it("follows the chat flow idle → think → talk → idle", () => {
    const m = new BehaviorMachine();
    expect(m.send("CHAT_START")).toBe(true);
    expect(m.state).toBe("think");
    expect(m.send("FIRST_TOKEN")).toBe(true);
    expect(m.state).toBe("talk");
    expect(m.send("SPEECH_END")).toBe(true);
    expect(m.state).toBe("idle");
  });

  it("goes to confused on error and back to idle after the one-shot", () => {
    expect(transition("think", "ERROR")).toBe("confused");
    expect(transition("confused", "ONE_SHOT_END")).toBe("idle");
  });

  it("ignores events that are invalid in the current state", () => {
    expect(transition("talk", "WANDER_START")).toBeNull();
    expect(transition("think", "SLEEP")).toBeNull();
    expect(transition("sleep", "WANDER_START")).toBeNull();
    expect(transition("idle", "ARRIVED")).toBeNull();
    const m = new BehaviorMachine();
    expect(m.send("FIRST_TOKEN")).toBe(false);
    expect(m.state).toBe("idle");
  });

  it("does not let wandering interrupt a conversation", () => {
    for (const busy of ["think", "talk"] as const) {
      expect(isBusy(busy)).toBe(true);
      expect(transition(busy, "WANDER_START")).toBeNull();
      expect(transition(busy, "SLEEP")).toBeNull();
    }
  });

  it("wakes from sleep through the wake animation", () => {
    expect(transition("idle", "SLEEP")).toBe("sleep");
    expect(transition("sleep", "WAKE")).toBe("wake");
    expect(transition("wake", "ONE_SHOT_END")).toBe("idle");
  });

  it("stops walking when picked up or arrived", () => {
    expect(transition("walk", "DRAG_START")).toBe("pickup");
    expect(transition("walk", "ARRIVED")).toBe("idle");
  });

  it("RESET returns to idle from every non-idle state", () => {
    for (const s of ANIMATION_NAMES) {
      expect(transition(s, "RESET")).toBe(s === "idle" ? null : "idle");
    }
  });

  it("every state has a path back to idle without RESET", () => {
    const exits: BehaviorEvent[] = ["ARRIVED", "SPEECH_END", "ONE_SHOT_END", "CANCEL", "WAKE", "PICKED_UP", "DROP", "LANDED"];
    for (const s of ANIMATION_NAMES) {
      const seen = new Set([s]);
      const queue = [s];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of exits) {
          const n = transition(cur, e);
          if (n && !seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      expect(seen.has("idle")).toBe(true);
    }
  });

  describe("holding Clawd (pickup → drag → land)", () => {
    const ALL_EVENTS: BehaviorEvent[] = [
      "WANDER_START", "ARRIVED", "IDLE_VARIATION", "CHAT_START", "FIRST_TOKEN", "SPEAK", "SPEECH_END", "ERROR", "CANCEL",
      "REACT_HAPPY", "FIDGET", "WAVE", "ONE_SHOT_END", "SLEEP", "WAKE", "DRAG_START", "PICKED_UP", "DROP", "LANDED",
    ];

    it("can be picked up from every state that isn't already held", () => {
      for (const s of ANIMATION_NAMES) {
        if (isHeld(s)) expect(transition(s, "DRAG_START")).toBeNull();
        else expect(transition(s, "DRAG_START")).toBe("pickup");
      }
    });

    it("runs pickup → drag → land → idle", () => {
      const m = new BehaviorMachine();
      m.send("WANDER_START");
      expect(m.send("DRAG_START")).toBe(true);
      expect(m.state).toBe("pickup");
      expect(m.send("PICKED_UP")).toBe(true);
      expect(m.state).toBe("drag");
      expect(m.send("DROP")).toBe(true);
      expect(m.state).toBe("land");
      expect(m.send("LANDED")).toBe(true);
      expect(m.state).toBe("idle");
    });

    it("a quick toss (drop during pickup) still lands", () => {
      expect(transition("pickup", "DROP")).toBe("land");
    });

    it("nothing but the drag protocol can change a held or landing state", () => {
      const allowed: Record<string, BehaviorEvent[]> = { pickup: ["PICKED_UP", "DROP"], drag: ["DROP"], land: ["LANDED"] };
      for (const s of ["pickup", "drag", "land"] as const) {
        for (const e of ALL_EVENTS) {
          if (allowed[s]!.includes(e)) continue;
          expect(transition(s, e), `${s} + ${e}`).toBeNull();
        }
      }
    });

    it("idle, wandering, and variations can't override landing", () => {
      for (const e of ["WANDER_START", "IDLE_VARIATION", "FIDGET", "ONE_SHOT_END", "SLEEP", "ARRIVED"] as const) {
        expect(transition("land", e)).toBeNull();
      }
    });

    it("dragging outranks everything, landing outranks idle behavior", () => {
      for (const s of ANIMATION_NAMES) {
        if (!isHeld(s)) expect(STATE_PRIORITY.drag).toBeGreaterThan(STATE_PRIORITY[s]);
      }
      for (const s of ["idle", "idle-variation", "walk", "sleep", "action"] as const) {
        expect(STATE_PRIORITY.land).toBeGreaterThan(STATE_PRIORITY[s]);
      }
    });
  });

  it("notifies listeners with next, previous and event", () => {
    const m = new BehaviorMachine();
    const seen: string[] = [];
    const off = m.onChange((next, prev, event) => seen.push(`${prev}->${next}:${event}`));
    m.send("WANDER_START");
    m.send("ARRIVED");
    off();
    m.send("SLEEP");
    expect(seen).toEqual(["idle->walk:WANDER_START", "walk->idle:ARRIVED"]);
  });
});
