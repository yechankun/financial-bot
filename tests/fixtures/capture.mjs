import fs from "node:fs/promises";
import path from "node:path";
const outputDir = process.argv[process.argv.indexOf("--out-dir") + 1];
const file = path.join(outputDir, "page-1.png");
// One transparent pixel is sufficient to exercise artifact storage and attachment delivery.
await fs.writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
console.log(file);
