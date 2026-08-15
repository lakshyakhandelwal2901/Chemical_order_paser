import fs from "fs";
import path from "path";
import { parseOrder } from "./extract.js";

async function main() {
  const dir = process.cwd();
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  if (files.length === 0) {
    console.error("No PDF files found in the current directory.");
    process.exit(1);
  }

  for (const f of files) {
    const full = path.join(dir, f);
    console.log("---\nParsing:", f);
    const buffer = fs.readFileSync(full);
    try {
      const result = await parseOrder({ buffer, mimetype: "application/pdf", originalname: f });
      console.log(JSON.stringify({ filename: f, ...result }, null, 2));
    } catch (err) {
      console.error(`Failed to parse ${f}:`, err.message);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
