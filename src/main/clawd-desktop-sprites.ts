/**
 * Reads Clawd's original pixel-art animations from the user's own installed
 * Claude desktop app. The artwork is Anthropic's: it is never bundled with or
 * committed to this project. This module only reads the user's local copy
 * (read-only), decodes it, and the result is written to the user's private
 * sprite folder.
 *
 * Nothing from the app is executed. Sprite records are located with text
 * matching and parsed as data.
 */
import * as nodeFs from "node:fs";

/**
 * Inside Electron, the regular fs module treats .asar archives as folders, so
 * the Claude app's app.asar would look like a directory. "original-fs" is
 * Electron's unpatched fs; plain Node (tests, scripts) uses node:fs.
 */
const fs: typeof nodeFs = process.versions.electron
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("original-fs") as typeof nodeFs)
  : nodeFs;

export interface RawSprite {
  name: string;
  category: string;
  width: number;
  height: number;
  fps: number;
  /** CSS hex colors; pixel values index into this list. */
  palette: string[];
  /** Pixel indices of the first frame, row-major; 255 = transparent. */
  frames: Uint8Array[];
  /** Anchor point (feet, horizontally centered) in frame pixels. */
  anchorX: number;
  anchorY: number;
}

export const TRANSPARENT = 255;

/** The most recently modified existing copy among candidate paths (see PlatformAdapter.claudeDesktopArchives), or null. */
export function findClaudeDesktopAsar(candidates: readonly string[]): string | null {
  const found = candidates.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return found[0] ?? null;
}

interface AsarEntry {
  files?: Record<string, AsarEntry>;
  size?: number;
  offset?: string;
  unpacked?: boolean;
}

/**
 * Minimal read-only asar reader: returns the text of the first file whose name
 * matches `pattern`. Format: 16-byte pickle header, JSON directory tree, data.
 */
export function readAsarText(asarPath: string, pattern: RegExp): { name: string; text: string } | null {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) throw new Error("Unexpected app archive format.");
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    const tree = JSON.parse(json.toString("utf8")) as AsarEntry;
    let hit: { name: string; entry: AsarEntry } | null = null;
    const walk = (node: AsarEntry): void => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        if (hit) return;
        if (child.files) walk(child);
        else if (pattern.test(name) && !child.unpacked && child.offset !== undefined) hit = { name, entry: child };
      }
    };
    walk(tree);
    const found = hit as { name: string; entry: AsarEntry } | null;
    if (!found) return null;
    const size = found.entry.size ?? 0;
    if (size <= 0 || size > 64 * 1024 * 1024) throw new Error("Unexpected sprite file size.");
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 8 + headerSize + Number(found.entry.offset));
    return { name: found.name, text: buf.toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

const SPRITE_START = /[,{]([A-Za-z][A-Za-z0-9_]*):\{cat:"([A-Za-z]+)"/g;
const HEX = /^#[0-9a-fA-F]{6}$/;

function field(segment: string, re: RegExp): string | null {
  return segment.match(re)?.[1] ?? null;
}

/** Applies one frame's changes ("<base36 index><value>,...") to the running pixel buffer. */
function applyDelta(pixels: Uint8Array, delta: string): void {
  if (!delta) return;
  for (const change of delta.split(",")) {
    if (change.length < 2) continue;
    const index = parseInt(change.slice(0, -1), 36);
    const v = change.at(-1) as string;
    if (Number.isInteger(index) && index >= 0 && index < pixels.length) pixels[index] = v === "." ? TRANSPARENT : parseInt(v, 36);
  }
}

/** Frame changes are stored either as one "("-separated string or as an array of strings. */
function readDeltas(segment: string): string[] | null {
  const joined = field(segment, /deltas:"([^"]*)"\.split\("\("\)/);
  if (joined !== null) return joined.split("(");
  const list = field(segment, /deltas:(\[[^\]]*\])/);
  if (list !== null) {
    try {
      const parsed = JSON.parse(list) as unknown;
      if (Array.isArray(parsed) && parsed.every((d) => typeof d === "string")) return parsed as string[];
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Extracts every sprite record from the engine source. Frames after the first
 * are cumulative: each one applies its changes on top of the previous frame.
 */
export function parseSprites(source: string, skipped: { name: string; reason: string }[] = []): RawSprite[] {
  const sprites: RawSprite[] = [];
  for (const m of source.matchAll(SPRITE_START)) {
    const name = m[1] as string;
    const category = m[2] as string;
    const start = m.index ?? 0;
    const end = source.indexOf("}", source.indexOf("a0:[", start));
    if (end < 0) {
      skipped.push({ name, reason: "no anchor field" });
      continue;
    }
    const seg = source.slice(start, end + 1);
    const width = Number(field(seg, /\bw:(\d+)/));
    const height = Number(field(seg, /\bh:(\d+)/));
    const fps = Number(field(seg, /\bfps:(\d+)/) ?? 10);
    const paletteText = field(seg, /palette:(\[[^\]]*\])/);
    const base = field(seg, /base:"([^"]*)"/);
    const deltas = readDeltas(seg);
    const a0 = (field(seg, /a0:\[([\d,\s]*)\]/) ?? "").split(",").map(Number);
    if (!width || !height || !paletteText || base === null || deltas === null) {
      const missing = Object.entries({ width, height, paletteText, base, deltas })
        .filter(([, v]) => !v && v !== "")
        .map(([k]) => k);
      skipped.push({ name, reason: `missing ${missing.join(", ")}` });
      continue;
    }
    if (width > 256 || height > 256 || base.length !== width * height) {
      skipped.push({ name, reason: `size ${width}x${height} but ${base.length} pixels` });
      continue;
    }
    let palette: string[];
    try {
      palette = (JSON.parse(paletteText) as unknown[]).filter((c): c is string => typeof c === "string" && HEX.test(c));
    } catch {
      continue;
    }
    const pixels = Uint8Array.from([...base].map((c) => (c === "." ? TRANSPARENT : parseInt(c, 36))));
    const frames = [pixels.slice()];
    for (const delta of deltas) {
      applyDelta(pixels, delta);
      frames.push(pixels.slice());
    }
    const [ax = 0, ay = 0, aw = 0, ah = 0] = a0;
    const box = aw > 0 ? [ax, ay, aw, ah] : [0, 0, width, height];
    sprites.push({
      name,
      category,
      width,
      height,
      fps: Math.min(30, Math.max(1, fps)),
      palette,
      frames,
      anchorX: (box[0] as number) + (box[2] as number) / 2,
      anchorY: (box[1] as number) + (box[3] as number),
    });
  }
  return sprites;
}

/** Reads and decodes all sprites from an installed Claude desktop app. */
export function loadClaudeDesktopSprites(asarPath: string): RawSprite[] {
  const engine = readAsarText(asarPath, /^clawdQuestEngine-.*\.js$/);
  if (!engine) throw new Error("This version of the Claude app doesn't contain the Clawd animations in a format this importer understands.");
  const sprites = parseSprites(engine.text);
  if (sprites.length === 0) throw new Error("No Clawd animations were found in the Claude app. Its format may have changed.");
  return sprites;
}
