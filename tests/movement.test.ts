import { describe, expect, it } from "vitest";
import {
  clampPosition,
  computeBounds,
  defaultPosition,
  effectiveWorkArea,
  findContainingArea,
  pickWanderTarget,
  stepToward,
} from "../src/shared/movement";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: -200, width: 2560, height: 1400 };
const size = { width: 280, height: 268 };

/** Deterministic pseudo-random sequence for tests. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe("movement bounds", () => {
  it("keeps the whole window inside the work area", () => {
    const b = computeBounds(primary, size);
    expect(b).toEqual({ minX: 0, maxX: 1640, minY: 0, maxY: 772 });
    expect(clampPosition({ x: -50, y: 5000 }, b)).toEqual({ x: 0, y: 772 });
    expect(clampPosition({ x: 9999, y: -10 }, b)).toEqual({ x: 1640, y: 0 });
  });

  it("handles windows larger than the screen", () => {
    const b = computeBounds({ x: 0, y: 0, width: 200, height: 200 }, size);
    expect(b.minX).toBe(b.maxX);
    expect(b.minY).toBe(b.maxY);
  });

  it("places the companion bottom-right by default", () => {
    const p = defaultPosition(primary, size);
    expect(p.y).toBe(1040 - 268);
    expect(p.x).toBeGreaterThan(1500);
  });

  it("supports monitors with negative coordinates", () => {
    const b = computeBounds(secondary, size);
    expect(clampPosition({ x: 0, y: -500 }, b)).toEqual({ x: 1920, y: -200 });
  });
});

describe("multi-monitor", () => {
  it("finds the display the window mostly overlaps", () => {
    expect(findContainingArea({ x: 1800, y: 100, ...size }, [primary, secondary])).toBe(secondary);
    expect(findContainingArea({ x: 100, y: 100, ...size }, [primary, secondary])).toBe(primary);
  });
  it("returns null when the window is entirely off-screen (monitor unplugged)", () => {
    expect(findContainingArea({ x: 6000, y: 100, ...size }, [primary, secondary])).toBeNull();
  });
});

describe("wandering", () => {
  it("always picks targets within bounds and far enough away", () => {
    const b = computeBounds(primary, size);
    const rng = seeded(7);
    for (let i = 0; i < 500; i++) {
      const x = Math.round(rng() * b.maxX);
      const t = pickWanderTarget(x, b, rng);
      if (t === null) continue;
      expect(t).toBeGreaterThanOrEqual(b.minX);
      expect(t).toBeLessThanOrEqual(b.maxX);
    }
  });

  it("refuses to wander when there is no room", () => {
    const b = { minX: 0, maxX: 50, minY: 0, maxY: 0 };
    expect(pickWanderTarget(25, b, seeded())).toBeNull();
  });

  it("walks toward the target at the configured speed and arrives exactly", () => {
    expect(stepToward(0, 100, 70, 1000)).toEqual({ x: 70, arrived: false });
    expect(stepToward(90, 100, 70, 1000)).toEqual({ x: 100, arrived: true });
    expect(stepToward(100, 0, 50, 500)).toEqual({ x: 75, arrived: false });
    expect(stepToward(5, 5, 50, 33).arrived).toBe(true);
    expect(stepToward(0, 10, 50, -5)).toEqual({ x: 0, arrived: false });
  });
});

describe("auto-hide taskbar", () => {
  const bounds = { x: 0, y: 0, width: 2560, height: 1080 };
  it("keeps a bottom margin when the OS reserves no taskbar space", () => {
    expect(effectiveWorkArea(bounds, bounds)).toEqual({ x: 0, y: 0, width: 2560, height: 1032 });
  });
  it("uses the real work area when a taskbar is reserved", () => {
    const wa = { x: 0, y: 0, width: 2560, height: 1040 };
    expect(effectiveWorkArea(bounds, wa)).toBe(wa);
  });
});
