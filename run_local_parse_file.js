import fs from "fs";
import path from "path";
import { hasTextLayer, extractPdfLines } from "./pdfTextExtract.js";
import { parseItemTable } from "./tableParser.js";
import { extractHeaderMetadata } from "./headerMetadata.js";

async function run(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error("File not found:", filePath);
    process.exit(2);
  }

  const buffer = fs.readFileSync(filePath);

  const hasText = await hasTextLayer(buffer);
  if (!hasText) {
    console.log(`No text layer detected in '${path.basename(filePath)}'. Local parsing cannot proceed.`);
    return;
  }

  const lines = await extractPdfLines(buffer);
  const { items, confidence, headerLine } = parseItemTable(lines);
  const metadata = extractHeaderMetadata(lines, headerLine);

  console.log(JSON.stringify({ filename: path.basename(filePath), hasTextLayer: hasText, confidence, metadata, items }, null, 2));
}

const fileArg = process.argv[2];
if (!fileArg) {
  console.error("Usage: node run_local_parse_file.js <path-to-pdf>");
  process.exit(1);
}

run(fileArg).catch((err) => {
  console.error(err);
  process.exit(1);
});
