/**
 * Generates the home-screen icons as PNGs with no external dependencies —
 * Node's zlib is all a PNG encoder actually needs.
 *
 * Design: blue field with three white waves. Rendered at 4x and box-filtered
 * down so the curves are antialiased.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/* ------------------------------------------------------------- PNG encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace, all 0

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ----------------------------------------------------------------- drawing */

const BG = [37, 99, 235]; // blue-600, the app's primary
const BG_DEEP = [29, 78, 216]; // blue-700, for a slight vertical gradient
const FG = [255, 255, 255];

/**
 * Coverage of the wave motif at a point in unit space (0..1 on both axes).
 * `spread` scales the motif about the centre so the maskable variant can keep
 * clear of Android's circular crop.
 */
function waveCoverage(u, v, spread) {
  const cu = 0.5 + (u - 0.5) / spread;
  const cv = 0.5 + (v - 0.5) / spread;
  if (cu < -0.2 || cu > 1.2) return 0;

  const bands = [0.35, 0.5, 0.65];
  const amplitude = 0.055;
  const thickness = 0.076;

  for (let i = 0; i < bands.length; i++) {
    const phase = i * 0.9;
    const y = bands[i] + amplitude * Math.sin(cu * Math.PI * 3.2 + phase);
    if (Math.abs(cv - y) < thickness / 2) return 1;
  }
  return 0;
}

function render(size, { spread = 1 } = {}) {
  const ss = 4; // supersampling factor
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          hits += waveCoverage(u, v, spread);
        }
      }
      const a = hits / (ss * ss);

      const t = y / size;
      const bg = [
        Math.round(BG[0] + (BG_DEEP[0] - BG[0]) * t),
        Math.round(BG[1] + (BG_DEEP[1] - BG[1]) * t),
        Math.round(BG[2] + (BG_DEEP[2] - BG[2]) * t),
      ];

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(bg[0] + (FG[0] - bg[0]) * a);
      rgba[i + 1] = Math.round(bg[1] + (FG[1] - bg[1]) * a);
      rgba[i + 2] = Math.round(bg[2] + (FG[2] - bg[2]) * a);
      rgba[i + 3] = 255; // opaque: iOS composites touch icons on white anyway
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * ICO container around PNG-encoded frames — supported everywhere an .ico is,
 * since Vista. Browsers fetch `/favicon.ico` directly for the tab icon
 * regardless of what `<link rel="icon">` points to, so this has to carry the
 * same wave mark as the PNGs or the tab shows a stale/default icon even when
 * the rest of the icons are right.
 */
function encodeIco(pngsBySize) {
  const count = pngsBySize.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  pngsBySize.forEach(({ size, png }, i) => {
    const e = i * 16;
    entries[e] = size >= 256 ? 0 : size; // width
    entries[e + 1] = size >= 256 ? 0 : size; // height
    entries[e + 2] = 0; // palette
    entries[e + 3] = 0; // reserved
    entries.writeUInt16LE(1, e + 4); // planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(png.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...pngsBySize.map((p) => p.png)]);
}

const out = process.argv[2];
const targets = [
  ["icon-180.png", 180, {}],
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  // Android crops maskable icons to a circle covering the middle 80%.
  ["icon-maskable-512.png", 512, { spread: 0.72 }],
];

for (const [name, size, opts] of targets) {
  const png = render(size, opts);
  writeFileSync(`${out}/${name}`, png);
  console.log(`${name}  ${size}x${size}  ${png.length} bytes`);
}

const favicon = encodeIco(
  [16, 32, 48].map((size) => ({ size, png: render(size) })),
);
writeFileSync(`${out}/favicon.ico`, favicon);
console.log(`favicon.ico  16/32/48  ${favicon.length} bytes`);
