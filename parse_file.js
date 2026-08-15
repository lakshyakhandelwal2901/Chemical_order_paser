import fs from "fs";
import path from "path";
import { parseOrder } from "./extract.js";

async function main() {
  const [, , inputPath] = process.argv;

  if (!inputPath) {
    console.error("Usage: node parse_file.js <pdf-path>");
    process.exit(1);
  }

  const resolvedPath = path.resolve(inputPath);
  const buffer = fs.readFileSync(resolvedPath);
  const result = await parseOrder({
    buffer,
    mimetype: "application/pdf",
    originalname: path.basename(resolvedPath),
  });

  process.stdout.write(JSON.stringify({ filename: path.basename(resolvedPath), ...result }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});