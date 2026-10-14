/**
 * Builds a Clawd sprite pack from the original animations in the user's own
 * Claude desktop app (see clawd-desktop-sprites.ts) and writes it to the
 * user's private sprite folder. Nothing here contains or ships artwork; the
 * pack exists only on the user's computer.
 *
 * Every frame is placed on one shared canvas aligned on Clawd's feet (the
 * source sprites' anchor), so switching animations never makes him jump.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AnimationName } from "../shared/types";
import { TRANSPARENT, type RawSprite } from "./clawd-desktop-sprites";
import { encodePng } from "./png";

/** A slice of one source animation. `frames` are inclusive indices into the source. */
export interface SequencePlan {
  sprite: string;
  from: number;
  to: number;
  loop: boolean;
  /** Source frame index the loop restarts from (must be within from..to). */
  loopFrom?: number;
  fps?: number;
  /** Name shown in the "Do a trick" menu. */
  label?: string;
}

/**
 * Which original animation plays for each state. Indices come from the
 * frame-by-frame structure of the source animations (e.g. Jumping: crouch at
 * 4, push off at 5, airborne 6–11, landing squash and rebound 12–15). If an
 * app update changes a sequence, it is skipped and the normal fallback chain
 * applies.
 */
export const CLAWD_PLAN: Partial<Record<AnimationName, SequencePlan[]>> = {
  idle: [{ sprite: "Walking", from: 0, to: 0, loop: true, fps: 1 }],
  "idle-variation": [
    { sprite: "LookingAround", from: 0, to: 30, loop: false, label: "Look around" },
    { sprite: "Swaying", from: 0, to: 48, loop: false, label: "Sway" },
    { sprite: "Turning", from: 0, to: 28, loop: false, label: "Turn around" },
  ],
  walk: [{ sprite: "Walking", from: 4, to: 9, loop: true, loopFrom: 5 }],
  think: [{ sprite: "Thinking", from: 4, to: 19, loop: true, loopFrom: 8 }],
  talk: [{ sprite: "Laptop", from: 9, to: 19, loop: true, loopFrom: 17 }],
  happy: [
    { sprite: "JumpingHappy", from: 4, to: 16, loop: false, label: "Jump for joy" },
    { sprite: "Excited", from: 3, to: 22, loop: false, label: "Get excited" },
    { sprite: "DancingHappy", from: 7, to: 39, loop: false, label: "Happy dance" },
  ],
  confused: [
    { sprite: "Dizzy", from: 6, to: 40, loop: false },
    { sprite: "Facepalm", from: 3, to: 34, loop: false },
    { sprite: "Disappointed", from: 6, to: 43, loop: false },
  ],
  sleep: [{ sprite: "Meditating", from: 6, to: 36, loop: true, loopFrom: 16 }],
  wake: [{ sprite: "Meditating", from: 46, to: 59, loop: false }],
  action: [
    { sprite: "Hula", from: 8, to: 53, loop: false, label: "Hula" },
    { sprite: "Pointing", from: 6, to: 42, loop: false, label: "Point" },
    { sprite: "CrabWalking", from: 4, to: 19, loop: false, label: "Crab shuffle" },
  ],
  idea: [{ sprite: "Lightbulb", from: 4, to: 49, loop: false, label: "Lightbulb moment" }],
  wave: [{ sprite: "Waving", from: 4, to: 16, loop: false, label: "Wave" }],
  pickup: [{ sprite: "Jumping", from: 4, to: 5, loop: false }],
  drag: [{ sprite: "Jumping", from: 6, to: 11, loop: true }],
  land: [{ sprite: "Jumping", from: 12, to: 16, loop: false }],
};

export interface BuiltSequence {
  frames: Uint8Array[];
  fps: number;
  loop: boolean;
  loopStart: number;
  label?: string;
}

export interface BuiltPack {
  frameWidth: number;
  frameHeight: number;
  bodyBox: [number, number, number, number];
  animations: Partial<Record<AnimationName, BuiltSequence[]>>;
  skipped: string[];
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Composes the planned sequences onto one feet-aligned canvas as RGBA frames. */
export function buildClawdPack(sprites: readonly RawSprite[], plan = CLAWD_PLAN): BuiltPack {
  const byName = new Map(sprites.map((s) => [s.name, s]));
  const skipped: string[] = [];
  const valid: [AnimationName, SequencePlan, RawSprite][] = [];
  for (const [anim, seqs] of Object.entries(plan) as [AnimationName, SequencePlan[]][]) {
    for (const p of seqs) {
      const s = byName.get(p.sprite);
      if (!s || p.from < 0 || p.to < p.from || p.to >= s.frames.length) {
        skipped.push(`${anim}: ${p.sprite} ${p.from}–${p.to}`);
        continue;
      }
      valid.push([anim, p, s]);
    }
  }
  if (!valid.some(([anim]) => anim === "idle")) throw new Error("The Claude app's Clawd animations don't include a standing pose this importer recognizes.");

  // Shared canvas: big enough for every used sprite with its anchor on a common point.
  let half = 0;
  let up = 0;
  let down = 0;
  for (const [, , s] of valid) {
    half = Math.max(half, Math.ceil(s.anchorX), Math.ceil(s.width - s.anchorX));
    up = Math.max(up, Math.ceil(s.anchorY));
    down = Math.max(down, Math.ceil(s.height - s.anchorY));
  }
  const W = half * 2;
  const H = up + down;

  const compose = (s: RawSprite, frame: Uint8Array): Uint8Array => {
    const out = new Uint8Array(W * H * 4);
    const ox = Math.round(half - s.anchorX);
    const oy = Math.round(up - s.anchorY);
    const pal = s.palette.map(hexToRgb);
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const v = frame[y * s.width + x] as number;
        if (v === TRANSPARENT) continue;
        const c = pal[v];
        if (!c) continue;
        const tx = x + ox;
        const ty = y + oy;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const i = (ty * W + tx) * 4;
        out[i] = c[0];
        out[i + 1] = c[1];
        out[i + 2] = c[2];
        out[i + 3] = 255;
      }
    }
    return out;
  };

  const animations: BuiltPack["animations"] = {};
  for (const [anim, p, s] of valid) {
    const frames = s.frames.slice(p.from, p.to + 1).map((f) => compose(s, f));
    const loopStart = p.loop && p.loopFrom !== undefined && p.loopFrom >= p.from && p.loopFrom <= p.to ? p.loopFrom - p.from : 0;
    (animations[anim] ??= []).push({ frames, fps: p.fps ?? s.fps, loop: p.loop, loopStart, ...(p.label ? { label: p.label } : {}) });
  }

  // Body box: the opaque bounds of the standing pose.
  const idle = animations.idle?.[0]?.frames[0] as Uint8Array;
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((idle[(y * W + x) * 4 + 3] as number) === 0) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const bodyBox: [number, number, number, number] = x1 >= 0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : [0, 0, W, H];
  return { frameWidth: W, frameHeight: H, bodyBox, animations, skipped };
}

export const CLAWD_PACK_ID = "clawd";

/**
 * Writes the pack (one horizontal PNG strip per sequence plus manifest.json)
 * into `<spritesDir>/clawd`, replacing any previous import atomically.
 */
export function writeClawdPack(built: BuiltPack, spritesDir: string, sourceLabel: string): string {
  const finalDir = path.join(spritesDir, CLAWD_PACK_ID);
  const tmpDir = path.join(spritesDir, `.${CLAWD_PACK_ID}-import-${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const W = built.frameWidth;
  const H = built.frameHeight;
  const manifestAnimations: Record<string, unknown[]> = {};
  for (const [anim, seqs] of Object.entries(built.animations)) {
    manifestAnimations[anim] = (seqs ?? []).map((seq, i) => {
      const file = `${anim}${i > 0 ? `-${i + 1}` : ""}.png`;
      const n = seq.frames.length;
      const strip = new Uint8Array(W * n * H * 4);
      seq.frames.forEach((f, fi) => {
        for (let y = 0; y < H; y++) strip.set(f.subarray(y * W * 4, (y + 1) * W * 4), (y * W * n + fi * W) * 4);
      });
      fs.writeFileSync(path.join(tmpDir, file), encodePng(W * n, H, strip));
      return { sheet: file, frameCount: n, fps: seq.fps, loop: seq.loop, loopStart: seq.loopStart, ...(seq.label ? { label: seq.label } : {}) };
    });
  }
  const manifest = {
    name: "Clawd",
    version: 1,
    official: true,
    placeholder: false,
    author: "Anthropic",
    source: sourceLabel,
    license: "© Anthropic. Imported from your own Claude app for personal use on this computer. Do not redistribute.",
    attribution: "Clawd and his animations are Anthropic's artwork, read from the Claude desktop app installed on this computer.",
    frameWidth: W,
    frameHeight: H,
    bodyBox: built.bodyBox,
    animations: manifestAnimations,
  };
  fs.writeFileSync(path.join(tmpDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(tmpDir, finalDir);
  return finalDir;
}
