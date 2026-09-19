"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { getCurrentUser, type SessionUser } from "@/lib/auth-api";
import {
  getRequest,
  updateRequest,
  type ProductCandidate,
  type RequestDetail,
  type RequestItem,
  type RequestStatus,
} from "@/lib/procurement-api";

const STATUS_OPTIONS: RequestStatus[] = ["PROCESSING", "READY_FOR_REVIEW", "IN_PROGRESS", "DELIVERED", "CANCELLED"];

function formatMoney(value: number | null) {
  if (value === null) return "—";
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// A flagged row's candidates always include the current pick (that's how
// buildRequestProductRows/PATCH populate it), so the brand already on the
// row identifies which candidate is selected - no separate "selected" field
// needed on load.
function selectionsFromItems(items: RequestItem[]) {
  const selections: Record<number, number> = {};
  for (const item of items) {
    if (!item.candidate_products) continue;
    const current = item.candidate_products.find((c) => c.brand === item.brand);
    if (current) selections[item.id] = current.product_id;
  }
  return selections;
}

// Live (client-side) view of an item's identity/price/stock fields, driven
// by whichever candidate is currently selected in the dropdown - not the
// last-saved values. This is what makes switching brands update the Code,
// MRP, Purchase, GST, Stock, and Short By columns immediately instead of
// only after Save.
function effectiveFields(item: RequestItem, selectedProductId: number | undefined) {
  const candidate: ProductCandidate | undefined = item.candidate_products?.find(
    (c) => c.product_id === selectedProductId
  );
  if (!candidate) {
    return {
      brand: item.brand,
      code: item.code,
      sku: item.sku,
      mrp: item.mrp,
      purchase_price: item.purchase_price,
      stock: item.stock,
      gst: item.gst,
      short_by: item.short_by,
    };
  }
  const shortBy = candidate.stock !== null ? Math.max(0, (item.quantity_required ?? 0) - candidate.stock) : null;
  return {
    brand: candidate.brand,
    code: candidate.code,
    sku: candidate.sku,
    mrp: candidate.mrp,
    purchase_price: candidate.purchase_price,
    stock: candidate.stock,
    gst: candidate.gst,
    short_by: shortBy,
  };
}

// Order: qty x file price. Quotation: qty x MRP x (1 + gst% - discount%).
// Rate contract: qty x rc price (rc_price isn't populated by anything yet -
// rate contract import hasn't been built - so this reads as "—" until then).
function lineTotal(
  item: RequestItem,
  effective: ReturnType<typeof effectiveFields>,
  fileType: RequestDetail["file_type"],
  discount: number | null
) {
  const qty = item.quantity_required;
  if (qty === null) return null;
  if (fileType === "ORDER") {
    return item.file_price !== null ? qty * item.file_price : null;
  }
  if (fileType === "QUOTATION") {
    if (effective.mrp === null) return null;
    const gstPct = effective.gst ?? 0;
    const discPct = discount ?? 0;
    return qty * effective.mrp * (1 + gstPct / 100 - discPct / 100);
  }
  if (fileType === "RATE_CONTRACT") {
    return item.rc_price !== null ? qty * item.rc_price : null;
  }
  return null;
}

export default function RequestDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const requestId = Number(params.id);

  const [, setUser] = useState<SessionUser | null>(null);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [status, setStatus] = useState<RequestStatus>("PROCESSING");
  const [requestComment, setRequestComment] = useState("");
  const [comments, setComments] = useState<Record<number, string>>({});
  const [discounts, setDiscounts] = useState<Record<number, string>>({});
  const [selectedCandidates, setSelectedCandidates] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser().then((result) => {
      if (!result) {
        router.replace("/login");
        return;
      }
      setUser(result.user);
    });
  }, [router]);

  useEffect(() => {
    if (!Number.isInteger(requestId)) return;
    getRequest(requestId)
      .then((data) => {
        setDetail(data);
        setStatus(data.status);
        setRequestComment(data.comment ?? "");
        setComments(Object.fromEntries(data.items.map((item) => [item.id, item.comment ?? ""])));
        setDiscounts(Object.fromEntries(data.items.map((item) => [item.id, item.discount?.toString() ?? ""])));
        setSelectedCandidates(selectionsFromItems(data.items));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load request."))
      .finally(() => setLoading(false));
  }, [requestId]);

  const totals = useMemo(() => {
    if (!detail) return null;
    let sum = 0;
    let anyKnown = false;
    for (const item of detail.items) {
      const effective = effectiveFields(item, selectedCandidates[item.id]);
      const discountValue = discounts[item.id] ? Number(discounts[item.id]) : null;
      const total = lineTotal(item, effective, detail.file_type, discountValue);
      if (total !== null) {
        sum += total;
        anyKnown = true;
      }
    }
    return anyKnown ? sum : null;
  }, [detail, selectedCandidates, discounts]);

  async function handleSave() {
    if (!detail) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await updateRequest(requestId, {
        status,
        comment: requestComment.trim() || null,
        items: detail.items.map((item) => ({
          id: item.id,
          comment: comments[item.id]?.trim() || null,
          discount: discounts[item.id] ? Number(discounts[item.id]) : null,
          ...(item.candidate_products && selectedCandidates[item.id] !== undefined
            ? { product_id: selectedCandidates[item.id] }
            : {}),
        })),
      });
      setDetail(updated);
      setStatus(updated.status);
      setRequestComment(updated.comment ?? "");
      setComments(Object.fromEntries(updated.items.map((item) => [item.id, item.comment ?? ""])));
      setDiscounts(Object.fromEntries(updated.items.map((item) => [item.id, item.discount?.toString() ?? ""])));
      setSelectedCandidates(selectionsFromItems(updated.items));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center text-slate-500">Loading...</main>;
  }

  if (error && !detail) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      </main>
    );
  }

  if (!detail) return null;

  const isQuotation = detail.file_type === "QUOTATION";
  const isRateContract = detail.file_type === "RATE_CONTRACT";

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <button
        type="button"
        onClick={() => router.push("/management")}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> Back to dashboard
      </button>

      <div className="rounded-[1.4rem] border border-stone-200/80 bg-white/80 p-6 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-700">
              {detail.file_type.replace(/_/g, " ")} #{detail.file_number}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-slate-950">
              {detail.party_name}
              {detail.party_matched === 0 && (
                <span className="ml-2 text-sm font-medium text-amber-700">(other — not a known RC party)</span>
              )}
            </h1>
          </div>
          <div className="text-right text-sm text-slate-600">
            <p>
              Salesperson: <span className="font-medium text-slate-900">{detail.salesperson_name ?? detail.salesperson_username}</span>
            </p>
            <p>Submitted: {detail.submission_date}</p>
            <p>Delivery: {detail.delivery_date}</p>
          </div>
        </div>

        <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-3">S.No</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Specs</th>
                <th className="px-4 py-3">Code / SKU</th>
                <th className="px-4 py-3">Brand</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">File Price</th>
                {isQuotation && <th className="px-4 py-3 text-right">MRP</th>}
                {isQuotation && <th className="px-4 py-3 text-right">GST</th>}
                {isQuotation && <th className="px-4 py-3 text-right">Discount %</th>}
                {isRateContract && <th className="px-4 py-3 text-right">RC Price</th>}
                {!isQuotation && !isRateContract && <th className="px-4 py-3 text-right">Purchase</th>}
                <th className="px-4 py-3 text-right">Stock</th>
                <th className="px-4 py-3 text-right">Short By</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Comment</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item, index) => {
                const effective = effectiveFields(item, selectedCandidates[item.id]);
                const discountValue = discounts[item.id] ? Number(discounts[item.id]) : null;
                const total = lineTotal(item, effective, detail.file_type, discountValue);
                return (
                  <tr key={item.id} className="border-b border-stone-100 last:border-none">
                    <td className="px-3 py-3 text-slate-500">{index + 1}</td>
                    <td className="px-4 py-3 text-slate-900">
                      {item.product_name_raw}
                      {!effective.sku && !effective.code && !item.candidate_products && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          <AlertTriangle className="h-3 w-3" /> No match
                        </span>
                      )}
                      {item.candidate_products && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          <AlertTriangle className="h-3 w-3" /> Multiple brands
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {[item.pack_size, item.specification].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-600">
                      {effective.code ?? effective.sku ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {item.candidate_products ? (
                        <select
                          value={selectedCandidates[item.id] ?? ""}
                          onChange={(event) =>
                            setSelectedCandidates((prev) => ({ ...prev, [item.id]: Number(event.target.value) }))
                          }
                          className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                        >
                          {item.candidate_products.map((candidate) => (
                            <option key={candidate.product_id} value={candidate.product_id}>
                              {candidate.brand ?? "Unbranded"} —{" "}
                              {candidate.stock !== null ? `stock ${candidate.stock}` : "stock unknown"}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (effective.brand ?? "—")
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-900">{item.quantity_required ?? "—"}</td>
                    <td className="px-4 py-3 text-right text-slate-900">{formatMoney(item.file_price)}</td>
                    {isQuotation && <td className="px-4 py-3 text-right text-slate-900">{formatMoney(effective.mrp)}</td>}
                    {isQuotation && (
                      <td className="px-4 py-3 text-right text-slate-900">
                        {effective.gst !== null ? `${effective.gst}%` : "—"}
                      </td>
                    )}
                    {isQuotation && (
                      <td className="px-4 py-3 text-right">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          value={discounts[item.id] ?? ""}
                          onChange={(event) => setDiscounts((prev) => ({ ...prev, [item.id]: event.target.value }))}
                          placeholder="0"
                          className="w-20 rounded-lg border border-stone-300 bg-white px-2 py-1.5 text-right text-sm focus:border-teal-500 focus:outline-none"
                        />
                      </td>
                    )}
                    {isRateContract && (
                      <td className="px-4 py-3 text-right text-slate-900">{formatMoney(item.rc_price)}</td>
                    )}
                    {!isQuotation && !isRateContract && (
                      <td className="px-4 py-3 text-right text-slate-900">{formatMoney(effective.purchase_price)}</td>
                    )}
                    <td className="px-4 py-3 text-right text-slate-900">{effective.stock ?? "—"}</td>
                    <td className={`px-4 py-3 text-right font-medium ${effective.short_by && effective.short_by > 0 ? "text-rose-600" : "text-slate-900"}`}>
                      {effective.short_by ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-slate-900">{formatMoney(total)}</td>
                    <td className="px-4 py-3">
                      <input
                        value={comments[item.id] ?? ""}
                        onChange={(event) => setComments((prev) => ({ ...prev, [item.id]: event.target.value }))}
                        placeholder="Add a note..."
                        className="w-40 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-stone-200 bg-stone-50 font-semibold text-slate-900">
                <td colSpan={isQuotation ? 12 : isRateContract ? 10 : 9} className="px-4 py-3 text-right">
                  Total
                </td>
                <td className="px-4 py-3 text-right">{formatMoney(totals)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>

        <label className="mt-6 block space-y-1.5 text-sm font-medium text-slate-800">
          <span>Request note</span>
          <textarea
            value={requestComment}
            onChange={(event) => setRequestComment(event.target.value)}
            placeholder="Add a note visible on the dashboard..."
            rows={2}
            className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
        </label>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <span>Status</span>
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as RequestStatus)}
              className="rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-3">
            {saved && <span className="text-sm font-medium text-teal-700">Saved.</span>}
            {error && (
              <span role="alert" className="text-sm font-medium text-rose-700">
                {error}
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-2xl bg-teal-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
