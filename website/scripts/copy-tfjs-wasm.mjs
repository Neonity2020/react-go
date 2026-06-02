import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const wasmSrc = path.resolve(__dirname, "..", "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist");
const wasmOut = path.resolve(__dirname, "..", "public", "tfjs");

async function main() {
  await fs.mkdir(wasmOut, { recursive: true });

  const files = await fs.readdir(wasmSrc);
  const wasmFiles = files.filter((f) => f.endsWith(".wasm"));

  if (wasmFiles.length === 0) {
    console.warn("⚠ No .wasm files found in", wasmSrc);
    return;
  }

  for (const file of wasmFiles) {
    const src = path.join(wasmSrc, file);
    const dest = path.join(wasmOut, file);
    await fs.copyFile(src, dest);
    console.log(`✓ Copied ${file}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
