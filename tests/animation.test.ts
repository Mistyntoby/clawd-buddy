import { describe, expect, it } from "vitest";
import { frameAt } from "../src/renderer/animation/player";
import { Squash } from "../src/renderer/animation/squash";
import { MOTION } from "../src/shared/constants";
import { companionLayout } from "../src/shared/layout";
import { boundsForBody, dropPosition, stepWalk } from "../src/shared/movement";
import { parseManifest, resolveFallback } from "../src/shared/sprite-manifest";
import type { AnimationName } from "../src/shared/types";

describe("frame timing", () => {
  const loop = { frameCount: 6, fps: 10, loop: true, loopStart: 2 };
  it("plays the intro once, then loops from loopStart", () => {
    const frames = Array.from({ length: 14 }, (_, i) => frameAt(loop, i * 100 + 1));
    expect(frames).toEqual([0, 1, 2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5]);
  });
  it("holds the last frame of a one-shot", () => {
    const once = { frameCount: 3, fps: 10, loop: false, loopStart: 0 };
    expect([0, 150, 250, 5000].map((t) => frameAt(once, t))).toEqual([0, 1, 2, 2]);
  });
  it("survives bad input", () => {
    expect(frameAt({ frameCount: 0, fps: 10, loop: true, loopStart: 0 }, 500)).toBe(0);
    expect(frameAt(loop, -50)).toBe(0);
  });
});

describe("crisp pixel layout", () => {
  const base = { frameWidth: 44, frameHeight: 32, bodyBox: [14, 16, 16, 16] as const, scale: 3 };
  it("uses a whole number of device pixels per art pixel at any display scaling", () => {
    for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const l = companionLayout({ ...base, scaleFactor });
      expect(Number.isInteger(l.devicePixelsPerArtPixel)).toBe(true);
      expect(l.pixelScale * scaleFactor).toBeCloseTo(l.devicePixelsPerArtPixel, 9);
    }
  });
  it("centers the character, with the bubble area above and the input slot right under his feet", () => {
    const l = companionLayout({ ...base, scaleFactor: 1 });
    expect(l.character.y + l.character.height).toBeLessThan(l.window.height);
    expect(l.input.y).toBe(l.body.y + l.body.height + 6);
    expect(l.input.y + l.input.height).toBeLessThanOrEqual(l.window.height);
    expect(l.input.width).toBe(l.window.width - 16);
    expect(Math.abs(l.character.x * 2 + l.character.width - l.window.width)).toBeLessThanOrEqual(1);
    expect(l.body).toEqual({ x: l.character.x + 42, y: l.character.y + 48, width: 48, height: 48 });
  });
});

describe("squash and stretch", () => {
  const cfg = { stiffness: MOTION.squash.stiffness, damping: MOTION.squash.damping };
  it("squashes on landing, rebounds past rest with diminishing bounces, then settles exactly", () => {
    const s = new Squash(cfg);
    s.kick(MOTION.squash.land);
    const ys: number[] = [];
    for (let t = 0; t < 1500; t += 16) ys.push(s.update(16).scaleY);
    expect(ys[0]).toBeLessThan(1);
    const overshoot = Math.max(...ys);
    expect(overshoot).toBeGreaterThan(1); // the rebound
    expect(overshoot).toBeLessThan(1 + (1 - MOTION.squash.land.scaleY)); // smaller than the squash
    expect(s.settled).toBe(true);
    expect(s.current).toEqual({ scaleX: 1, scaleY: 1 });
  });
  it("settles within half a second (quick, not continuous bouncing)", () => {
    const s = new Squash(cfg);
    s.kick(MOTION.squash.land);
    let t = 0;
    while (!s.settled && t < 3000) {
      s.update(16);
      t += 16;
    }
    expect(t).toBeLessThan(700);
  });
  it("holds a carried pose while resting there, and reset() stops all motion", () => {
    const s = new Squash(cfg);
    s.setRest(MOTION.squash.carry);
    for (let i = 0; i < 100; i++) s.update(16);
    expect(s.current.scaleY).toBeCloseTo(MOTION.squash.carry.scaleY, 3);
    s.kick(MOTION.squash.land);
    s.reset();
    expect(s.update(16)).toEqual({ scaleX: 1, scaleY: 1 });
  });
  it("doesn't explode after a long pause (hidden window)", () => {
    const s = new Squash(cfg);
    s.kick(MOTION.squash.land);
    const v = s.update(60_000);
    expect(Number.isFinite(v.scaleX) && Math.abs(v.scaleY - 1) < 0.5).toBe(true);
  });
});

describe("walking motion", () => {
  it("accelerates, cruises, brakes, and stops exactly on target", () => {
    let st = { x: 0, v: 0 };
    const speeds: number[] = [];
    let arrived = false;
    for (let i = 0; i < 2000 && !arrived; i++) {
      const r = stepWalk(st, 400, 115, MOTION.walk.accel, 16);
      st = { x: r.x, v: r.v };
      speeds.push(r.v);
      arrived = r.arrived;
    }
    expect(arrived).toBe(true);
    expect(st.x).toBe(400);
    expect(speeds[0]).toBeLessThan(10); // smooth start
    expect(Math.max(...speeds)).toBeCloseTo(115, 0); // cruise
    expect(speeds.at(-2)!).toBeLessThan(30); // smooth stop
  });
  it("never overshoots, in either direction", () => {
    let st = { x: 500, v: 0 };
    for (let i = 0; i < 2000; i++) {
      const r = stepWalk(st, 120, 70, MOTION.walk.accel, 33);
      expect(r.x).toBeGreaterThanOrEqual(120);
      st = r;
      if (r.arrived) break;
    }
    expect(st.x).toBe(120);
  });
});

describe("body-aware placement", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const body = { x: 100, y: 150, width: 60, height: 50 };
  it("lets the transparent window margin hang off-screen while keeping the body visible", () => {
    const b = boundsForBody(area, body);
    expect(b.minX).toBe(-100);
    expect(b.maxX).toBe(1920 - 160);
    expect(b.minY).toBe(-150);
    expect(b.maxY).toBe(1080 - 200);
  });
  it("keeps a release position that already shows the body", () => {
    expect(dropPosition({ x: -80, y: -120 }, body, [area])).toEqual({ x: -80, y: -120 });
  });
  it("finds the nearest display for a drop in a gap between monitors", () => {
    const right = { x: 2000, y: 0, width: 1000, height: 800 };
    const inside = (p: { x: number; y: number }, a: typeof area) =>
      p.x + body.x >= a.x && p.x + body.x + body.width <= a.x + a.width && p.y + body.y >= a.y && p.y + body.y + body.height <= a.y + a.height;
    // Body mostly over the right monitor: it settles fully onto that one, moving as little as possible.
    const p = dropPosition({ x: 1880, y: 100 }, body, [area, right]);
    expect(inside(p, right)).toBe(true);
    expect(p).toEqual({ x: 1900, y: 100 });
    // Body entirely in the gap: pulled onto the nearest display.
    const q = dropPosition({ x: 1870, y: 900 }, body, [area, right]);
    expect(inside(q, area) || inside(q, right)).toBe(true);
  });
});

describe("manifest: loop points, variants, body box, fallbacks", () => {
  const base = { frameWidth: 32, frameHeight: 32 };
  it("parses loopStart and arrays of variants", () => {
    const r = parseManifest({
      ...base,
      bodyBox: [4, 6, 24, 26],
      animations: {
        idle: { frames: ["a.png"], fps: 1 },
        walk: { sheet: "w.png", frameCount: 6, fps: 12, loop: true, loopStart: 1 },
        happy: [
          { sheet: "h1.png", frameCount: 4, fps: 12, loop: false },
          { sheet: "h2.png", frameCount: 8, fps: 12, loop: false },
        ],
      },
    });
    expect(r.errors).toEqual([]);
    expect(r.manifest!.bodyBox).toEqual([4, 6, 24, 26]);
    expect(r.manifest!.animations.walk!.loopStart).toBe(1);
    expect(r.manifest!.animations.happy!.variants).toHaveLength(1);
  });
  it("rejects a body box outside the frame and an out-of-range loopStart", () => {
    const r = parseManifest({
      ...base,
      bodyBox: [20, 20, 40, 40],
      animations: { idle: { sheet: "i.png", frameCount: 2, fps: 2, loopStart: 9 } },
    });
    expect(r.manifest!.bodyBox).toEqual([0, 0, 32, 32]);
    expect(r.manifest!.animations.idle!.loopStart).toBe(0);
    expect(r.warnings.some((w) => w.includes("bodyBox"))).toBe(true);
  });
  it("missing drag sequences fall back gracefully", () => {
    const only = (names: AnimationName[]) => new Set<AnimationName>(names);
    expect(resolveFallback("drag", only(["idle", "pickup"]))).toBe("pickup");
    expect(resolveFallback("pickup", only(["idle"]))).toBe("idle");
    expect(resolveFallback("land", only(["idle"]))).toBe("idle");
    expect(resolveFallback("idle-variation", only(["idle"]))).toBe("idle");
    expect(resolveFallback("wave", only(["idle", "action"]))).toBe("action");
    expect(resolveFallback("wave", only([]))).toBeNull();
  });
});
