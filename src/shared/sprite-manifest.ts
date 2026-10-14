import { ANIMATION_NAMES, type AnimationName } from "./types";

/**
 * Sprite pack manifest parsing and validation.
 *
 * Pure (no fs access) so it can be unit-tested and reused. File existence is
 * checked separately by the main process asset provider.
 */

export interface ManifestSequence {
  /** Individual frame image files, relative to the pack directory. */
  frames?: string[];
  /** Alternatively, a horizontal sprite strip, relative to the pack directory. */
  sheet?: string;
  frameCount?: number;
  fps: number;
  loop: boolean;
  /** Frame index looping restarts from (an intro before it plays once). */
  loopStart: number;
  /** Optional display name for the "Do a trick" menu. */
  label?: string;
}

/** An animation is one sequence, or (in the manifest) an array of alternative sequences. */
export interface ManifestAnimation extends ManifestSequence {
  variants: ManifestSequence[];
}

export interface SpriteManifest {
  name: string;
  version: number;
  official: boolean;
  placeholder: boolean;
  author: string;
  source: string;
  license: string;
  attribution: string;
  frameWidth: number;
  frameHeight: number;
  /** Standing body bounds in frame pixels [x, y, w, h]; defaults to the whole frame. */
  bodyBox: [number, number, number, number];
  animations: Partial<Record<AnimationName, ManifestAnimation>>;
}

export interface ParseResult {
  manifest: SpriteManifest | null;
  errors: string[];
  warnings: string[];
}

const SAFE_FILE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(png|gif|webp)$/;

/** Rejects absolute paths, traversal, and anything outside a simple relative image path. */
export function isSafeRelativeImagePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  if (p.includes("..") || p.startsWith("/") || p.includes("\\") || p.includes(":")) return false;
  return SAFE_FILE.test(p);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 500) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fallback chain for missing animations. The first available entry wins;
 * "idle" is always the last resort.
 */
export const ANIMATION_FALLBACKS: Record<AnimationName, AnimationName[]> = {
  idle: [],
  "idle-variation": ["idle"],
  idea: ["action", "happy", "idle"],
  walk: ["idle"],
  think: ["idle"],
  talk: ["idle"],
  happy: ["action", "idle"],
  confused: ["think", "idle"],
  sleep: ["idle"],
  wake: ["idle"],
  action: ["happy", "idle"],
  wave: ["action", "happy", "idle"],
  pickup: ["drag", "action", "idle"],
  drag: ["pickup", "action", "idle"],
  land: ["idle"],
};

export function resolveFallback(
  name: AnimationName,
  available: ReadonlySet<AnimationName>,
): AnimationName | null {
  if (available.has(name)) return name;
  for (const candidate of ANIMATION_FALLBACKS[name]) {
    if (available.has(candidate)) return candidate;
  }
  return null;
}

export function parseManifest(raw: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { manifest: null, errors: ["Manifest must be a JSON object."], warnings };
  }

  const frameWidth = raw.frameWidth;
  const frameHeight = raw.frameHeight;
  if (typeof frameWidth !== "number" || !Number.isInteger(frameWidth) || frameWidth < 8 || frameWidth > 512) {
    errors.push("frameWidth must be an integer between 8 and 512.");
  }
  if (typeof frameHeight !== "number" || !Number.isInteger(frameHeight) || frameHeight < 8 || frameHeight > 512) {
    errors.push("frameHeight must be an integer between 8 and 512.");
  }

  const animations: Partial<Record<AnimationName, ManifestAnimation>> = {};
  if (!isRecord(raw.animations)) {
    errors.push("animations must be an object.");
  } else {
    for (const [key, value] of Object.entries(raw.animations)) {
      if (!(ANIMATION_NAMES as readonly string[]).includes(key)) {
        warnings.push(`Unknown animation "${key}" ignored.`);
        continue;
      }
      const name = key as AnimationName;
      const parsed = parseAnimation(name, value, warnings);
      if (parsed) animations[name] = parsed;
    }
    if (!animations.idle) {
      errors.push('An "idle" animation is required.');
    }
  }

  if (errors.length > 0) return { manifest: null, errors, warnings };

  const official = raw.official === true;
  const license = str(raw.license, "unspecified");
  if (official && license === "unspecified") {
    warnings.push("Pack claims to be official but declares no license; treat its provenance as unverified.");
  }

  return {
    manifest: {
      name: str(raw.name, "Unnamed sprite pack"),
      version: typeof raw.version === "number" ? raw.version : 1,
      official,
      placeholder: raw.placeholder === true,
      author: str(raw.author, "unknown"),
      source: str(raw.source, "unknown"),
      license,
      attribution: str(raw.attribution, ""),
      frameWidth: frameWidth as number,
      frameHeight: frameHeight as number,
      bodyBox: parseBodyBox(raw.bodyBox, frameWidth as number, frameHeight as number, warnings),
      animations,
    },
    errors,
    warnings,
  };
}

function label(value: Record<string, unknown>): { label?: string } {
  const l = value.label;
  return typeof l === "string" && l.trim() ? { label: l.trim().slice(0, 40) } : {};
}

function parseBodyBox(value: unknown, fw: number, fh: number, warnings: string[]): [number, number, number, number] {
  const whole: [number, number, number, number] = [0, 0, fw, fh];
  if (value === undefined) return whole;
  if (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0) &&
    (value[2] as number) > 0 &&
    (value[3] as number) > 0 &&
    (value[0] as number) + (value[2] as number) <= fw &&
    (value[1] as number) + (value[3] as number) <= fh
  ) {
    return value as [number, number, number, number];
  }
  warnings.push("bodyBox must be [x, y, width, height] inside the frame; using the whole frame.");
  return whole;
}

function parseAnimation(name: AnimationName, value: unknown, warnings: string[]): ManifestAnimation | null {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > 16) {
    warnings.push(`Animation "${name}" needs 1–16 sequences; skipped.`);
    return null;
  }
  const sequences = list.map((v, i) => parseSequence(list.length > 1 ? `${name}[${i}]` : name, v, warnings)).filter((s): s is ManifestSequence => s !== null);
  const [first, ...variants] = sequences;
  if (!first) return null;
  return { ...first, variants };
}

function parseSequence(name: string, value: unknown, warnings: string[]): ManifestSequence | null {
  if (!isRecord(value)) {
    warnings.push(`Animation "${name}" is not an object; skipped.`);
    return null;
  }
  const fpsRaw = value.fps;
  const fps = typeof fpsRaw === "number" && fpsRaw > 0 && fpsRaw <= 60 ? fpsRaw : 6;
  if (fpsRaw !== undefined && fps !== fpsRaw) warnings.push(`Animation "${name}" has invalid fps; using 6.`);
  const loop = value.loop !== false;
  const loopStartRaw = value.loopStart;
  const loopStartOk = loopStartRaw === undefined || (typeof loopStartRaw === "number" && Number.isInteger(loopStartRaw) && loopStartRaw >= 0);
  if (!loopStartOk) warnings.push(`Animation "${name}" has an invalid loopStart; using 0.`);
  const withLoopStart = (count: number): number => {
    const ls = loopStartOk && typeof loopStartRaw === "number" ? loopStartRaw : 0;
    return ls < count ? ls : 0;
  };

  if (Array.isArray(value.frames)) {
    const frames = value.frames.filter(isSafeRelativeImagePath);
    if (frames.length !== value.frames.length) {
      warnings.push(`Animation "${name}" has unsafe or invalid frame paths; they were dropped.`);
    }
    if (frames.length === 0 || frames.length > 240) {
      warnings.push(`Animation "${name}" has no usable frames; skipped.`);
      return null;
    }
    return { frames, fps, loop, loopStart: withLoopStart(frames.length), ...label(value) };
  }

  if (value.sheet !== undefined) {
    const count = value.frameCount;
    if (!isSafeRelativeImagePath(value.sheet)) {
      warnings.push(`Animation "${name}" has an unsafe sheet path; skipped.`);
      return null;
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 240) {
      warnings.push(`Animation "${name}" needs an integer frameCount (1–240); skipped.`);
      return null;
    }
    return { sheet: value.sheet, frameCount: count, fps, loop, loopStart: withLoopStart(count), ...label(value) };
  }

  warnings.push(`Animation "${name}" has neither "frames" nor "sheet"; skipped.`);
  return null;
}

/** All files a manifest references, for existence checks. */
export function referencedFiles(manifest: SpriteManifest): string[] {
  const files = new Set<string>();
  for (const anim of Object.values(manifest.animations)) {
    if (!anim) continue;
    for (const seq of [anim, ...anim.variants]) {
      for (const f of seq.frames ?? []) files.add(f);
      if (seq.sheet) files.add(seq.sheet);
    }
  }
  return [...files];
}
