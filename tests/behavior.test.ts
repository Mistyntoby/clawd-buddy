import { describe, expect, it } from "vitest";
import { BehaviorMachine, isBusy, transition } from "../src/shared/behavior";
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

  it("stops walking when dragged or arrived", () => {
    expect(transition("walk", "DRAG_START")).toBe("idle");
    expect(transition("walk", "ARRIVED")).toBe("idle");
  });

  it("RESET returns to idle from every non-idle state", () => {
    for (const s of ANIMATION_NAMES) {
      expect(transition(s, "RESET")).toBe(s === "idle" ? null : "idle");
    }
  });

  it("every state has a path back to idle", () => {
    for (const s of ANIMATION_NAMES) {
      const exits = ["ARRIVED", "SPEECH_END", "ONE_SHOT_END", "CANCEL", "WAKE"] as const;
      const reachable = exits.some((e) => {
        const n = transition(s, e);
        return n === "idle" || (n !== null && transition(n, "ONE_SHOT_END") === "idle");
      });
      expect(reachable || s === "idle").toBe(true);
    }
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
