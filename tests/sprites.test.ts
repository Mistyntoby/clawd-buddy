import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetProvider, discoverPacks, loadPack, resolveAssetRequest, selectPack, toPackInfo } from "../src/main/asset-provider";
import { isSafeRelativeImagePath, parseManifest, resolveFallback } from "../src/shared/sprite-manifest";
import { ANIMATION_NAMES, type AnimationName } from "../src/shared/types";

const PLACEHOLDER = path.join(__dirname, "..", "assets", "sprites", "placeholder");
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const minimal = (extra: Record<string, unknown> = {}) => ({
  frameWidth: 32,
  frameHeight: 32,
  animations: { idle: { frames: ["idle.png"], fps: 4, loop: true } },
  ...extra,
});

describe("manifest parsing", () => {
  it("accepts a minimal manifest with only idle", () => {
    const r = parseManifest(minimal());
    expect(r.errors).toEqual([]);
    expect(r.manifest?.animations.idle?.frames).toEqual(["idle.png"]);
    expect(r.manifest?.official).toBe(false);
  });

  it("requires idle and valid frame sizes", () => {
    expect(parseManifest({ frameWidth: 32, frameHeight: 32, animations: {} }).errors).toContain('An "idle" animation is required.');
    expect(parseManifest(minimal({ frameWidth: 0 })).manifest).toBeNull();
    expect(parseManifest(minimal({ frameHeight: 9999 })).manifest).toBeNull();
    expect(parseManifest("nope").manifest).toBeNull();
    expect(parseManifest(null).manifest).toBeNull();
  });

  it("drops unsafe paths instead of trusting them", () => {
    const r = parseManifest({
      frameWidth: 32,
      frameHeight: 32,
      animations: {
        idle: { frames: ["ok.png", "../../secret.png", "C:/x.png", "/abs.png", "a\\b.png", "script.js"], fps: 4 },
      },
    });
    expect(r.manifest?.animations.idle?.frames).toEqual(["ok.png"]);
    expect(r.warnings.some((w) => w.includes("unsafe"))).toBe(true);
  });

  it("validates sprite sheets and ignores unknown animations", () => {
    const r = parseManifest(
      minimal({
        animations: {
          idle: { sheet: "idle.png", frameCount: 4, fps: 6 },
          walk: { sheet: "walk.png" },
          dance: { frames: ["d.png"] },
        },
      }),
    );
    expect(r.manifest?.animations.idle).toMatchObject({ sheet: "idle.png", frameCount: 4 });
    expect(r.manifest?.animations.walk).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/frameCount/);
    expect(r.warnings.join(" ")).toMatch(/Unknown animation "dance"/);
  });

  it("warns when a pack claims to be official without a license", () => {
    const r = parseManifest(minimal({ official: true }));
    expect(r.warnings.join(" ")).toMatch(/unverified/);
  });

  it("isSafeRelativeImagePath", () => {
    expect(isSafeRelativeImagePath("frames/idle_0.png")).toBe(true);
    expect(isSafeRelativeImagePath("idle.gif")).toBe(true);
    expect(isSafeRelativeImagePath("..png")).toBe(false);
    expect(isSafeRelativeImagePath("a/../b.png")).toBe(false);
    expect(isSafeRelativeImagePath("idle.svg")).toBe(false);
    expect(isSafeRelativeImagePath(42)).toBe(false);
  });
});

describe("animation fallbacks", () => {
  it("falls back to idle for missing animations", () => {
    const only = new Set<AnimationName>(["idle"]);
    for (const n of ANIMATION_NAMES) expect(resolveFallback(n, only)).toBe("idle");
  });
  it("prefers closer fallbacks", () => {
    expect(resolveFallback("happy", new Set<AnimationName>(["idle", "action"]))).toBe("action");
    expect(resolveFallback("confused", new Set<AnimationName>(["idle", "think"]))).toBe("think");
  });
  it("returns null when nothing is available", () => {
    expect(resolveFallback("walk", new Set())).toBeNull();
  });
});

describe("bundled placeholder pack", () => {
  it("is valid, complete, clearly labeled, and not marked official", () => {
    const pack = loadPack("placeholder", PLACEHOLDER);
    expect(pack.errors).toEqual([]);
    expect(pack.warnings).toEqual([]);
    const info = toPackInfo(pack);
    expect(info.placeholder).toBe(true);
    expect(info.official).toBe(false);
    expect(info.missing).toEqual([]);
    expect(info.name.toLowerCase()).toContain("placeholder");
    expect(info.name.toLowerCase()).not.toContain("clawd");
  });
});

describe("asset provider", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-sprites-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function makePack(name: string, manifest: unknown, files: string[]): string {
    const dir = path.join(tmp, "user", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    for (const f of files) fs.writeFileSync(path.join(dir, f), PNG);
    return dir;
  }

  it("prefers a valid user pack over the placeholder", () => {
    makePack("mypack", minimal({ name: "Mine" }), ["idle.png"]);
    const packs = discoverPacks({ userDir: path.join(tmp, "user"), devLocalDir: null, placeholderDir: PLACEHOLDER });
    expect(selectPack(packs, "auto")?.id).toBe("mypack");
    expect(selectPack(packs, "placeholder")?.id).toBe("placeholder");
    expect(selectPack(packs, "does-not-exist")?.id).toBe("mypack");
  });

  it("reports broken packs without failing and falls back to the placeholder", () => {
    makePack("broken", "{ not json", []);
    makePack("noidle", { frameWidth: 32, frameHeight: 32, animations: { walk: { frames: ["w.png"] } } }, ["w.png"]);
    makePack("missingfiles", minimal(), []);
    const provider = new AssetProvider({ userDir: path.join(tmp, "user"), devLocalDir: null, placeholderDir: PLACEHOLDER });
    const info = provider.reload("auto");
    expect(info.id).toBe("placeholder");
    const list = provider.listPacks();
    expect(list.find((p) => p.id === "broken")?.valid).toBe(false);
    expect(list.find((p) => p.id === "noidle")?.valid).toBe(false);
    expect(list.find((p) => p.id === "missingfiles")?.errors.join(" ")).toMatch(/idle/);
  });

  it("drops animations whose files are missing, keeping the rest", () => {
    makePack(
      "partial",
      minimal({ animations: { idle: { frames: ["idle.png"] }, walk: { frames: ["walk_0.png"] }, talk: { sheet: "talk.png", frameCount: 2 } } }),
      ["idle.png"],
    );
    const pack = loadPack("partial", path.join(tmp, "user", "partial"));
    const info = toPackInfo(pack);
    expect(Object.keys(info.animations)).toEqual(["idle"]);
    expect(info.missing).toContain("walk");
    expect(pack.warnings.join(" ")).toMatch(/missing/);
  });

  it("returns an emergency pack when nothing is valid at all", () => {
    const info = new AssetProvider({ userDir: path.join(tmp, "none"), devLocalDir: null, placeholderDir: path.join(tmp, "nope") }).reload("auto");
    expect(info.id).toBe("none");
    expect(info.missing.length).toBe(ANIMATION_NAMES.length);
  });

  it("resolves asset URLs only inside registered packs", () => {
    const registry = new Map([["placeholder", PLACEHOLDER]]);
    expect(resolveAssetRequest("clawd-asset://placeholder/idle_0.png", registry)).toBe(path.join(PLACEHOLDER, "idle_0.png"));
    expect(resolveAssetRequest("clawd-asset://Placeholder/idle_0.png", registry)).not.toBeNull();
    expect(resolveAssetRequest("clawd-asset://placeholder/../../package.json", registry)).toBeNull();
    expect(resolveAssetRequest("clawd-asset://placeholder/%2e%2e%2fsecret.png", registry)).toBeNull();
    expect(resolveAssetRequest("clawd-asset://placeholder/manifest.json", registry)).toBeNull();
    expect(resolveAssetRequest("clawd-asset://other/idle_0.png", registry)).toBeNull();
    expect(resolveAssetRequest("file:///etc/passwd", registry)).toBeNull();
    expect(resolveAssetRequest("not a url", registry)).toBeNull();
  });
});
