import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const LINE_Y_TOLERANCE = 2.5; // px; text items within this y-distance are treated as the same line

/**
 * Extracts every text item from a PDF buffer, with position, grouped into
 * reading-order "lines" per page (items on the same horizontal band, sorted
 * left-to-right). Returns [] if the PDF has no text layer (i.e. it's a scan).
 *
 * @param {Buffer} buffer
 * @returns {Promise<Array<{ pageNum: number, y: number, items: Array<{text:string,x:number,y:number}> }>>}
 */
export async function extractPdfLines(buffer) {
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  const allLines = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });

    const items = content.items
      .filter((i) => i.str.trim() !== "")
      .map((i) => ({
        text: i.str.trim(),
        x: i.transform[4],
        y: viewport.height - i.transform[5], // flip so y increases downward
      }));

    items.sort((a, b) => a.y - b.y || a.x - b.x);

    const pageLines = [];
    for (const item of items) {
      let line = pageLines.find((l) => Math.abs(l.y - item.y) <= LINE_Y_TOLERANCE);
      if (!line) {
        line = { pageNum, y: item.y, items: [] };
        pageLines.push(line);
      }
      line.items.push(item);
    }
    pageLines.sort((a, b) => a.y - b.y);
    for (const l of pageLines) l.items.sort((a, b) => a.x - b.x);

    allLines.push(...pageLines);
  }

  return allLines;
}

/**
 * Quick check for whether a PDF has any usable text layer at all
 * (cheap way to decide "don't even try local parsing, go straight to AI").
 * @param {Buffer} buffer
 */
export async function hasTextLayer(buffer) {
  const lines = await extractPdfLines(buffer);
  const totalChars = lines.reduce(
    (sum, line) => sum + line.items.reduce((s, i) => s + i.text.length, 0),
    0
  );
  return totalChars > 20; // small threshold - filters out stray watermark/signature text
}
