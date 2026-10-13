import { ANIMATION_NAMES, type AnimationName } from "./types";

/**
 * Sprite pack manifest parsing and validation.
 *
 * Pure (no fs access) so it can be unit-tested and reused. File existence is
 * checked separately by the main process asset provider.
 */

export interface ManifestAnimation {
  /** Individual frame image files, relative to the pack directory. */
  frames?: string[];
  /** Alternatively, a horizontal sprite strip, relative to the pack directory. */
  sheet?: string;
  frameCount?: number;
  fps: number;
  loop: boolean;
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
  walk: ["idle"],
  think: ["idle"],
  talk: ["idle"],
  happy: ["action", "idle"],
  confused: ["think", "idle"],
  sleep: ["idle"],
  wake: ["idle"],
  action: ["happy", "idle"],
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
      animations,
    },
    errors,
    warnings,
  };
}

function parseAnimation(name: AnimationName, value: unknown, warnings: string[]): ManifestAnimation | null {
  if (!isRecord(value)) {
    warnings.push(`Animation "${name}" is not an object; skipped.`);
    return null;
  }
  const fpsRaw = value.fps;
  const fps = typeof fpsRaw === "number" && fpsRaw > 0 && fpsRaw <= 60 ? fpsRaw : 6;
  if (fpsRaw !== undefined && fps !== fpsRaw) warnings.push(`Animation "${name}" has invalid fps; using 6.`);
  const loop = value.loop !== false;

  if (Array.isArray(value.frames)) {
    const frames = value.frames.filter(isSafeRelativeImagePath);
    if (frames.length !== value.frames.length) {
      warnings.push(`Animation "${name}" has unsafe or invalid frame paths; they were dropped.`);
    }
    if (frames.length === 0 || frames.length > 120) {
      warnings.push(`Animation "${name}" has no usable frames; skipped.`);
      return null;
    }
    return { frames, fps, loop };
  }

  if (value.sheet !== undefined) {
    const count = value.frameCount;
    if (!isSafeRelativeImagePath(value.sheet)) {
      warnings.push(`Animation "${name}" has an unsafe sheet path; skipped.`);
      return null;
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 120) {
      warnings.push(`Animation "${name}" needs an integer frameCount (1–120); skipped.`);
      return null;
    }
    return { sheet: value.sheet, frameCount: count, fps, loop };
  }

  warnings.push(`Animation "${name}" has neither "frames" nor "sheet"; skipped.`);
  return null;
}

/** All files a manifest references, for existence checks. */
export function referencedFiles(manifest: SpriteManifest): string[] {
  const files = new Set<string>();
  for (const anim of Object.values(manifest.animations)) {
    if (!anim) continue;
    for (const f of anim.frames ?? []) files.add(f);
    if (anim.sheet) files.add(anim.sheet);
  }
  return [...files];
}
