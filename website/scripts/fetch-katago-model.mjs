import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { URL } from "node:url";

const MODEL_URL =
  "https://github.com/lightvector/KataGo/raw/master/cpp/tests/models/g170-b6c96-s175395328-d26788732.bin.gz";
const MODEL_NAME = "katago-small.bin.gz";
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.resolve(__dirname, "..", "public", "katago");
const outFile = path.join(outDir, MODEL_NAME);

async function main() {
  await fs.mkdir(outDir, { recursive: true });

  try {
    const stat = await fs.stat(outFile);
    console.log(`✓ Model already exists: ${outFile} (${(stat.size / 1e6).toFixed(1)} MB)`);
    return;
  } catch {
    // file doesn't exist, proceed to download
  }

  console.log(`Downloading KataGo model from ${MODEL_URL}...`);
  execSync(`curl -L -o "${outFile}" "${MODEL_URL}"`, { stdio: "inherit" });

  const stat = await fs.stat(outFile);
  console.log(`✓ Model saved: ${outFile} (${(stat.size / 1e6).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
