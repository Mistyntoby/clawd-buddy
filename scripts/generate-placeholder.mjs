// Generates the ORIGINAL placeholder character ("Pip", a little slate-blue blob bot)
// and the app icons. This is not Clawd and must never be labeled as Clawd artwork.
// Output: assets/sprites/placeholder/*.png + manifest.json, assets/icons/*.png
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets/sprites/placeholder");
const iconDir = join(root, "assets/icons");
mkdirSync(outDir, { recursive: true });
mkdirSync(iconDir, { recursive: true });

// ---- minimal PNG encoder (RGBA, 8-bit) --------------------------------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- tiny raster canvas -----------------------------------------------------------------
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = Buffer.alloc(w * h * 4);
  }
  px(x, y, color) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !color) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = color[0];
    this.data[i + 1] = color[1];
    this.data[i + 2] = color[2];
    this.data[i + 3] = color[3] ?? 255;
  }
  rect(x, y, w, h, color) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, color);
  }
  ellipse(cx, cy, rx, ry, colorFn) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.px(x, y, typeof colorFn === "function" ? colorFn(x, y) : colorFn);
      }
    }
  }
  /** Draws a pattern of strings; '.' is transparent, other chars map through the palette. */
  pattern(x, y, rows, palette) {
    rows.forEach((row, j) => [...row].forEach((ch, i) => ch !== "." && this.px(x + i, y + j, palette[ch])));
  }
  png() {
    return encodePng(this.w, this.h, this.data);
  }
}

const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const C = {
  outline: hex("#232a3b"),
  body: hex("#6f84ad"),
  shade: hex("#566a92"),
  light: hex("#9db0d4"),
  eye: hex("#151924"),
  shine: hex("#ffffff"),
  tip: hex("#f2c14e"),
  stem: hex("#3a4560"),
  cheek: hex("#e59aa8", 220),
  mouth: hex("#3b1f2a"),
  tongue: hex("#e07a8a"),
  foot: hex("#3a4560"),
  fx: hex("#ffffff", 235),
  fx2: hex("#f2c14e"),
  q: hex("#f2c14e"),
};

const W = 32;
const H = 32;

/** Draws one frame of Pip. */
function pip(o = {}) {
  const { dy = 0, eyes = "open", mouth = "smile", feet = 0, antenna = 0, arms = null, extra = null, lookUp = 0 } = o;
  const c = new Canvas(W, H);
  const cx = 16;
  const cy = 18 + dy;

  // feet
  const fl = feet === 1 ? -1 : 0;
  const fr = feet === 2 ? -1 : 0;
  c.rect(10, 26 + dy + fl, 4, 2, C.outline);
  c.rect(18, 26 + dy + fr, 4, 2, C.outline);
  c.rect(11, 26 + dy + fl, 2, 1, C.foot);
  c.rect(19, 26 + dy + fr, 2, 1, C.foot);

  // antenna
  const ax = cx + antenna;
  c.rect(cx, cy - 12, 1, 4, C.stem);
  c.rect(ax - 1, cy - 15, 3, 3, C.outline);
  c.px(ax, cy - 14, C.tip);

  // arms
  if (arms) {
    const [l, r] = arms; // vertical offsets
    c.rect(4, cy + l, 3, 2, C.outline);
    c.px(5, cy + l, C.body);
    c.rect(25, cy + r, 3, 2, C.outline);
    c.px(26, cy + r, C.body);
  }

  // body with outline, shading, and highlight
  c.ellipse(cx, cy, 11, 10, C.outline);
  c.ellipse(cx, cy, 10, 9, (x, y) => (y > cy + 4 ? C.shade : C.body));
  c.ellipse(cx - 4, cy - 5, 3, 2, C.light);

  // cheeks
  c.rect(9, cy + 2, 2, 1, C.cheek);
  c.rect(22, cy + 2, 2, 1, C.cheek);

  // eyes
  const ey = cy - 2 - lookUp;
  const eyeL = 12;
  const eyeR = 19;
  for (const ex of [eyeL, eyeR]) {
    if (eyes === "open") {
      c.rect(ex, ey, 2, 3, C.eye);
      c.px(ex, ey, C.shine);
    } else if (eyes === "closed") {
      c.rect(ex, ey + 2, 2, 1, C.eye);
    } else if (eyes === "half") {
      c.rect(ex, ey + 1, 2, 2, C.eye);
    } else if (eyes === "happy") {
      c.px(ex, ey + 1, C.eye);
      c.px(ex + 1, ey, C.eye);
      c.px(ex + 2, ey + 1, C.eye);
    }
  }
  if (eyes === "confused") {
    c.rect(eyeL, ey, 2, 3, C.eye);
    c.px(eyeL, ey, C.shine);
    c.rect(eyeR, ey + 1, 3, 1, C.eye);
  }

  // mouth
  const my = cy + 3;
  if (mouth === "smile") {
    c.px(15, my, C.mouth);
    c.px(16, my + 1, C.mouth);
    c.px(17, my, C.mouth);
  } else if (mouth === "open") {
    c.rect(15, my, 3, 2, C.mouth);
    c.px(16, my + 1, C.tongue);
  } else if (mouth === "flat") {
    c.rect(15, my + 1, 3, 1, C.mouth);
  } else if (mouth === "o") {
    c.rect(15, my, 2, 2, C.mouth);
  } else if (mouth === "wavy") {
    c.px(14, my + 1, C.mouth);
    c.px(15, my, C.mouth);
    c.px(16, my + 1, C.mouth);
    c.px(17, my, C.mouth);
  }

  // effects
  if (extra === "dots1" || extra === "dots2" || extra === "dots3") {
    const n = Number(extra.slice(-1));
    for (let i = 0; i < n; i++) c.rect(23 + i * 3, 4 - i, 2, 2, C.fx);
  }
  if (extra === "z1") c.pattern(23, 4, ["###", "..#", ".#.", "###"], { "#": C.fx });
  if (extra === "z2") {
    c.pattern(22, 6, ["###", "..#", ".#.", "###"], { "#": C.fx });
    c.pattern(27, 1, ["##", ".#", "##"], { "#": C.fx });
  }
  if (extra === "sparkle1") {
    c.pattern(3, 4, [".#.", "###", ".#."], { "#": C.fx2 });
    c.pattern(26, 7, [".#.", "###", ".#."], { "#": C.fx });
  }
  if (extra === "sparkle2") {
    c.pattern(5, 8, [".#.", "###", ".#."], { "#": C.fx });
    c.pattern(25, 2, [".#.", "###", ".#."], { "#": C.fx2 });
  }
  if (extra === "q1" || extra === "q2") {
    const qx = extra === "q1" ? 24 : 25;
    c.pattern(qx, 1, [".##.", "#..#", "...#", "..#.", "..#.", "....", "..#."], { "#": C.q });
  }
  if (extra === "bang") c.pattern(25, 1, ["#", "#", "#", ".", "#"], { "#": C.fx2 });
  return c;
}

// ---- animations ---------------------------------------------------------------------------
const anims = {
  idle: {
    fps: 4,
    loop: true,
    frames: [{}, {}, { dy: 1, antenna: 1 }, { dy: 1, eyes: "closed", antenna: 1 }],
  },
  walk: {
    fps: 8,
    loop: true,
    sheet: true,
    frames: [
      { feet: 1, antenna: -1 },
      { dy: -1, antenna: 0 },
      { feet: 2, antenna: 1 },
      { dy: -1, antenna: 0 },
    ],
  },
  think: {
    fps: 3,
    loop: true,
    frames: [
      { eyes: "open", lookUp: 1, mouth: "flat", extra: "dots1" },
      { eyes: "open", lookUp: 1, mouth: "flat", extra: "dots2", antenna: 1 },
      { eyes: "open", lookUp: 1, mouth: "flat", extra: "dots3" },
    ],
  },
  talk: {
    fps: 7,
    loop: true,
    frames: [{ mouth: "open" }, { mouth: "smile" }, { mouth: "o", dy: 0 }, { mouth: "smile" }],
  },
  happy: {
    fps: 6,
    loop: true,
    frames: [
      { dy: -3, eyes: "happy", mouth: "open", arms: [-4, -4], extra: "sparkle1" },
      { dy: 0, eyes: "happy", mouth: "smile", arms: [0, 0], extra: "sparkle2" },
    ],
  },
  confused: {
    fps: 3,
    loop: true,
    frames: [
      { eyes: "confused", mouth: "wavy", extra: "q1", antenna: -1 },
      { eyes: "confused", mouth: "wavy", extra: "q2", antenna: 1 },
    ],
  },
  sleep: {
    fps: 1.5,
    loop: true,
    frames: [
      { dy: 1, eyes: "closed", mouth: "flat", extra: "z1" },
      { dy: 2, eyes: "closed", mouth: "o", extra: "z2" },
    ],
  },
  wake: {
    fps: 3,
    loop: false,
    frames: [
      { dy: 1, eyes: "half", mouth: "o" },
      { eyes: "open", mouth: "o", extra: "bang" },
      { eyes: "open", mouth: "smile" },
    ],
  },
  action: {
    fps: 8,
    loop: true,
    frames: [
      { arms: [-4, 0], mouth: "open" },
      { arms: [-2, -2], mouth: "smile" },
      { arms: [0, -4], mouth: "open" },
      { arms: [-2, -2], mouth: "smile" },
    ],
  },
};

const manifest = {
  name: "Pip (original placeholder)",
  version: 1,
  official: false,
  placeholder: true,
  author: "Clawd Buddy contributors",
  source: "Generated by scripts/generate-placeholder.mjs in this repository",
  license: "MIT (same as the Clawd Buddy source code)",
  attribution: "Original placeholder character created for Clawd Buddy. Not Clawd, and not Anthropic artwork.",
  frameWidth: W,
  frameHeight: H,
  animations: {},
};

for (const [name, def] of Object.entries(anims)) {
  if (def.sheet) {
    const sheet = new Canvas(W * def.frames.length, H);
    def.frames.forEach((f, i) => {
      const frame = pip(f);
      for (let y = 0; y < H; y++) frame.data.copy(sheet.data, (y * sheet.w + i * W) * 4, y * W * 4, (y + 1) * W * 4);
    });
    writeFileSync(join(outDir, `${name}.png`), sheet.png());
    manifest.animations[name] = { sheet: `${name}.png`, frameCount: def.frames.length, fps: def.fps, loop: def.loop };
  } else {
    const files = def.frames.map((f, i) => {
      const file = `${name}_${i}.png`;
      writeFileSync(join(outDir, file), pip(f).png());
      return file;
    });
    manifest.animations[name] = { frames: files, fps: def.fps, loop: def.loop };
  }
}
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// ---- app icon: orange rounded square with a white speech bubble (not a character) ---------
function icon(size) {
  const c = new Canvas(size, size);
  const s = size / 32;
  const orange = hex("#d97757");
  const dark = hex("#b85f42");
  const white = hex("#fff7ee");
  const r = 7 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(r - x - 0.5, x + 0.5 - (size - r), 0);
      const dy = Math.max(r - y - 0.5, y + 0.5 - (size - r), 0);
      if (dx * dx + dy * dy <= r * r) c.px(x, y, y > size * 0.82 ? dark : orange);
    }
  }
  // bubble
  const bx = 6 * s, by = 7 * s, bw = 20 * s, bh = 13 * s, br = 4 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const lx = x + 0.5 - bx, ly = y + 0.5 - by;
      if (lx < 0 || ly < 0 || lx > bw || ly > bh) continue;
      const ddx = Math.max(br - lx, lx - (bw - br), 0);
      const ddy = Math.max(br - ly, ly - (bh - br), 0);
      if (ddx * ddx + ddy * ddy <= br * br) c.px(x, y, white);
    }
  }
  // tail
  for (let j = 0; j < 5 * s; j++) for (let i = 0; i < 5 * s - j; i++) c.px(10 * s + i, by + bh + j, white);
  // dots
  for (const dx of [11, 16, 21]) c.ellipse(dx * s, 13.5 * s, 1.6 * s, 1.6 * s, orange);
  return c.png();
}
writeFileSync(join(iconDir, "icon.png"), icon(256));
writeFileSync(join(iconDir, "tray.png"), icon(32));
writeFileSync(join(iconDir, "tray@2x.png"), icon(64));

console.info("Placeholder sprites → assets/sprites/placeholder, icons → assets/icons");
