import * as fs from "node:fs";
import * as path from "node:path";
import { ASSET_PROTOCOL, PLACEHOLDER_PACK_ID } from "../shared/constants";
import { isSafeRelativeImagePath, parseManifest, referencedFiles, type ManifestSequence, type SpriteManifest } from "../shared/sprite-manifest";
import { ANIMATION_NAMES, type AnimationName, type ResolvedAnimation, type ResolvedSequence, type SpritePackInfo } from "../shared/types";

/**
 * Discovers sprite packs, validates them, and serves their files.
 *
 * Search locations (highest priority first):
 *   1. <userData>/sprites/<pack>/manifest.json  — the user's authorized artwork
 *   2. assets/sprites/local/<pack>/              — developer-local, git-ignored
 *   3. the bundled original placeholder pack
 *
 * Nothing here ever crashes on bad input: invalid packs are reported and skipped.
 */

export interface PackCandidate {
  id: string;
  dir: string;
  manifest: SpriteManifest | null;
  errors: string[];
  warnings: string[];
}

export interface AssetSearchPaths {
  userDir: string;
  devLocalDir: string | null;
  placeholderDir: string;
}

const PACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function loadPack(id: string, dir: string): PackCandidate {
  const manifestPath = path.join(dir, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      id,
      dir,
      manifest: null,
      errors: [code === "ENOENT" ? "manifest.json not found." : "manifest.json is not valid JSON."],
      warnings: [],
    };
  }
  const result = parseManifest(raw);
  if (!result.manifest) return { id, dir, manifest: null, errors: result.errors, warnings: result.warnings };

  // Drop references to files that do not exist.
  const warnings = [...result.warnings];
  const missingFiles = new Set(referencedFiles(result.manifest).filter((f) => !fs.existsSync(path.join(dir, f))));
  if (missingFiles.size > 0) {
    warnings.push(`${missingFiles.size} referenced image file(s) are missing.`);
    const usable = (seq: ManifestSequence): ManifestSequence | null => {
      if (seq.frames) {
        const frames = seq.frames.filter((f) => !missingFiles.has(f));
        return frames.length > 0 ? { ...seq, frames, loopStart: seq.loopStart < frames.length ? seq.loopStart : 0 } : null;
      }
      return seq.sheet && !missingFiles.has(seq.sheet) ? seq : null;
    };
    for (const [name, anim] of Object.entries(result.manifest.animations)) {
      if (!anim) continue;
      const [first, ...variants] = [anim, ...anim.variants].map(usable).filter((s): s is ManifestSequence => s !== null);
      if (first) result.manifest.animations[name as AnimationName] = { ...first, variants };
      else delete result.manifest.animations[name as AnimationName];
    }
    if (!result.manifest.animations.idle) {
      return { id, dir, manifest: null, errors: ['The "idle" animation has no usable image files.'], warnings };
    }
  }
  return { id, dir, manifest: result.manifest, errors: [], warnings };
}

export function discoverPacks(paths: AssetSearchPaths): PackCandidate[] {
  const packs: PackCandidate[] = [];
  const seen = new Set<string>();
  for (const root of [paths.userDir, paths.devLocalDir]) {
    if (!root) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PACK_ID.test(entry.name) || entry.name === PLACEHOLDER_PACK_ID) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      packs.push(loadPack(entry.name, path.join(root, entry.name)));
    }
  }
  packs.push(loadPack(PLACEHOLDER_PACK_ID, paths.placeholderDir));
  return packs;
}

/** Chooses the active pack: explicit selection if valid, else the first valid user pack, else the placeholder. */
export function selectPack(packs: PackCandidate[], preferred: string): PackCandidate | null {
  const valid = packs.filter((p) => p.manifest);
  if (preferred !== "auto") {
    const chosen = valid.find((p) => p.id === preferred);
    if (chosen) return chosen;
  }
  return valid.find((p) => p.id !== PLACEHOLDER_PACK_ID) ?? valid.find((p) => p.id === PLACEHOLDER_PACK_ID) ?? null;
}

export function assetUrl(packId: string, file: string): string {
  return `${ASSET_PROTOCOL}://${packId}/${file.split("/").map(encodeURIComponent).join("/")}`;
}

export function toPackInfo(pack: PackCandidate | null): SpritePackInfo {
  if (!pack || !pack.manifest) {
    // Emergency pack: no images at all. The renderer draws a simple CSS shape.
    return {
      id: "none",
      name: "No sprites available",
      official: false,
      placeholder: true,
      author: "",
      source: "",
      license: "",
      attribution: "",
      frameWidth: 32,
      frameHeight: 32,
      bodyBox: [0, 0, 32, 32],
      animations: {},
      missing: [...ANIMATION_NAMES],
      warnings: ["No valid sprite pack was found; using a built-in shape."],
    };
  }
  const m = pack.manifest;
  const animations: Partial<Record<AnimationName, ResolvedAnimation>> = {};
  const resolve = (seq: ManifestSequence): ResolvedSequence =>
    seq.frames
      ? { frames: seq.frames.map((f) => assetUrl(pack.id, f)), frameCount: seq.frames.length, fps: seq.fps, loop: seq.loop, loopStart: seq.loopStart, ...(seq.label ? { label: seq.label } : {}) }
      : { sheet: assetUrl(pack.id, seq.sheet as string), frameCount: seq.frameCount ?? 1, fps: seq.fps, loop: seq.loop, loopStart: seq.loopStart, ...(seq.label ? { label: seq.label } : {}) };
  for (const [name, anim] of Object.entries(m.animations)) {
    if (!anim) continue;
    animations[name as AnimationName] = { ...resolve(anim), variants: anim.variants.map(resolve) };
  }
  return {
    id: pack.id,
    name: m.name,
    official: m.official,
    placeholder: m.placeholder || pack.id === PLACEHOLDER_PACK_ID,
    author: m.author,
    source: m.source,
    license: m.license,
    attribution: m.attribution,
    frameWidth: m.frameWidth,
    frameHeight: m.frameHeight,
    bodyBox: m.bodyBox,
    animations,
    missing: ANIMATION_NAMES.filter((n) => !animations[n]),
    warnings: pack.warnings,
  };
}

/**
 * Resolves a clawd-asset:// URL to an absolute file path inside a registered
 * pack directory, or null if the request is invalid or escapes the pack.
 */
export function resolveAssetRequest(url: string, registry: ReadonlyMap<string, string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ASSET_PROTOCOL}:`) return null;
  const dir = registry.get(parsed.hostname.toLowerCase());
  if (!dir) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  if (!isSafeRelativeImagePath(rel)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

export class AssetProvider {
  private packs: PackCandidate[] = [];
  private active: PackCandidate | null = null;
  /** packId (lower-case, as URL hosts are case-insensitive) → directory */
  readonly registry = new Map<string, string>();

  constructor(private readonly paths: AssetSearchPaths) {}

  reload(preferred: string): SpritePackInfo {
    this.packs = discoverPacks(this.paths);
    this.registry.clear();
    for (const p of this.packs) if (p.manifest) this.registry.set(p.id.toLowerCase(), p.dir);
    this.active = selectPack(this.packs, preferred);
    return this.info();
  }

  info(): SpritePackInfo {
    return toPackInfo(this.active);
  }

  /** Summary of every discovered pack, for the diagnostics panel. */
  listPacks(): { id: string; name: string; valid: boolean; errors: string[]; warnings: string[]; active: boolean }[] {
    return this.packs.map((p) => ({
      id: p.id,
      name: p.manifest?.name ?? p.id,
      valid: p.manifest !== null,
      errors: p.errors,
      warnings: p.warnings,
      active: p === this.active,
    }));
  }

  get userDir(): string {
    return this.paths.userDir;
  }
}
