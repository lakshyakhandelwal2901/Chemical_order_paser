import PDFDocument from "pdfkit";

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }

  return `₹${Number(value).toFixed(2)}`;
}

function dateText(value) {
  return value || "-";
}

function safeText(value) {
  return value === null || value === undefined || value === "" ? "-" : String(value);
}

function addKeyValue(doc, label, value, x, y, labelWidth = 150) {
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text(label, x, y, { width: labelWidth });
  doc.font("Helvetica").fillColor("#111827").text(value, x + labelWidth, y, { width: 360 });
}

function drawTableHeader(doc, x, y, columns) {
  const rowHeight = 22;
  doc.save();
  doc.fillColor("#0f172a");
  doc.rect(x, y, columns.reduce((sum, column) => sum + column.width, 0), rowHeight).fill("#e2e8f0");
  doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(9);

  let offsetX = x;
  for (const column of columns) {
    doc.text(column.label, offsetX + 6, y + 7, { width: column.width - 12, align: column.align || "left" });
    offsetX += column.width;
  }

  doc.restore();
  return rowHeight;
}

function drawTableRow(doc, x, y, columns, values) {
  const rowHeight = 26;
  doc.save();
  doc.strokeColor("#cbd5e1").lineWidth(0.5).rect(x, y, columns.reduce((sum, column) => sum + column.width, 0), rowHeight).stroke();

  let offsetX = x;
  columns.forEach((column, index) => {
    doc.font("Helvetica").fontSize(8).fillColor("#111827").text(safeText(values[index]), offsetX + 5, y + 6, {
      width: column.width - 10,
      align: column.align || "left",
    });
    offsetX += column.width;
  });

  doc.restore();
  return rowHeight;
}

export async function buildQuotationPdfBuffer(quotation) {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));

    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a").text("Quotation", { align: "center" });
    doc.moveDown(0.6);

    const customerName = quotation?.customer?.canonical_name || quotation?.customer?.customer_id || "Unassigned customer";
    const rateCardName = quotation?.items?.find((item) => item?.pricing?.source === "customer_rate_card")?.pricing?.rate_card_name || "-";

    addKeyValue(doc, "Customer", customerName, 40, doc.y);
    addKeyValue(doc, "Quotation date", dateText(quotation?.quotation_date), 40, doc.y + 16);
    addKeyValue(doc, "Rate card", rateCardName, 40, doc.y + 32);
    addKeyValue(doc, "Match", `${safeText(quotation?.customer_match?.match_method)} (${quotation?.customer_match?.match_score ?? "-"})`, 40, doc.y + 48);

    doc.moveDown(4);

    const columns = [
      { label: "Item", width: 185 },
      { label: "SKU", width: 65 },
      { label: "Source", width: 95 },
      { label: "Qty", width: 40, align: "right" },
      { label: "Unit price", width: 70, align: "right" },
      { label: "Amount", width: 70, align: "right" },
    ];

    const startX = 40;
    let currentY = doc.y;
    currentY += drawTableHeader(doc, startX, currentY, columns);

    for (const item of quotation?.items || []) {
      if (currentY > 730) {
        doc.addPage();
        currentY = 40;
        currentY += drawTableHeader(doc, startX, currentY, columns);
      }

      currentY += drawTableRow(doc, startX, currentY, columns, [
        item.item_name,
        item.sku,
        item.pricing?.source,
        item.requested_quantity,
        money(item.quotation?.unit_price),
        money(item.quotation?.amount),
      ]);
    }

    doc.moveDown(1.2);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a").text(`Items quoted: ${quotation?.summary?.item_count ?? 0}`);
    doc.text(`Priced from rate card: ${quotation?.summary?.priced_from_rate_card ?? 0}`);
    doc.text(`Priced from inventory: ${quotation?.summary?.priced_from_inventory ?? 0}`);

    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text(`All available: ${quotation?.summary?.all_available ? "Yes" : "No"}`);

    doc.end();
  });
}