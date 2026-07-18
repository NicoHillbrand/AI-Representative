// Generates the tray icons (16x16 + 32x32 PNGs) with zero dependencies:
// a filled circle — gray when idle, green when you're available.
// Run once via `npm run icons`; the PNGs are committed to assets/.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "assets");
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
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
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Render a size×size RGBA circle with soft (2px-feathered) edges. */
function circlePng(size, [r, g, b]) {
  const cx = (size - 1) / 2;
  const radius = size / 2 - 1;
  // Each scanline is prefixed with filter byte 0.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cx);
      const alpha = Math.max(0, Math.min(1, radius - d + 0.5));
      const o = row + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = Math.round(alpha * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const COLORS = {
  idle: [140, 145, 155], // gray
  available: [61, 190, 108], // green
};
for (const [name, color] of Object.entries(COLORS)) {
  for (const size of [16, 32]) {
    const file = join(outDir, `tray-${name}${size === 32 ? "@2x" : ""}.png`);
    writeFileSync(file, circlePng(size, color));
    console.log("wrote", file);
  }
}
