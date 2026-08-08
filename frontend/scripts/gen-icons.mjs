// Generates PNG icons for the PWA manifest from the SVG source.
// Run once: node scripts/gen-icons.mjs
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "../public/icons/icon.svg");
const OUT = path.join(__dirname, "../public/icons");

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

for (const size of sizes) {
  await sharp(SRC)
    .resize(size, size)
    .png()
    .toFile(path.join(OUT, `icon-${size}.png`));
  console.log(`  ✓ icon-${size}.png`);
}

// Apple touch icon (180px is the standard size)
await sharp(SRC).resize(180, 180).png().toFile(path.join(OUT, "apple-icon.png"));
console.log("  ✓ apple-icon.png");
