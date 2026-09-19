"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { getCurrentUser, logout, type SessionUser } from "@/lib/auth-api";
import {
  listRequests,
  updateRequest,
  type RequestSummary,
  type RequestStatus,
  type RequestType,
} from "@/lib/procurement-api";

const TABS: { value: RequestType | "ALL" | "DELIVERED"; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "ORDER", label: "Orders" },
  { value: "RATE_CONTRACT", label: "Rate Contracts" },
  { value: "QUOTATION", label: "Quotations" },
  { value: "DELIVERED", label: "Delivered" },
];

const STATUS_STYLES: Record<RequestStatus, string> = {
  PROCESSING: "bg-stone-100 text-stone-600",
  READY_FOR_REVIEW: "bg-amber-100 text-amber-800",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  DELIVERED: "bg-teal-100 text-teal-800",
  CANCELLED: "bg-rose-100 text-rose-700",
};

function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export default function ManagementPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<(typeof TABS)[number]["value"]>("ALL");
  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [comments, setComments] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentUser()
      .then((result) => {
        if (!result) {
          router.replace("/login");
          return;
        }
        setUser(result.user);
      })
      .finally(() => setLoading(false));
  }, [router]);

  const loadRequests = useCallback(() => {
    setError(null);
    // The Delivered tab pulls across every type; the other tabs exclude
    // delivered entries once they've moved there - each request lives in
    // exactly one of the two views, never both.
    const typeFilter = tab === "ALL" || tab === "DELIVERED" ? undefined : tab;
    listRequests(typeFilter)
      .then((result) => {
        const filtered =
          tab === "DELIVERED"
            ? result.requests.filter((r) => r.status === "DELIVERED")
            : result.requests.filter((r) => r.status !== "DELIVERED");
        setRequests(filtered);
        setComments(Object.fromEntries(filtered.map((r) => [r.id, r.comment ?? ""])));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load requests."));
  }, [tab]);

  useEffect(() => {
    if (!loading && user) loadRequests();
  }, [loading, user, loadRequests]);

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  async function handleCommentBlur(requestId: number, original: string | null) {
    const value = comments[requestId] ?? "";
    if (value.trim() === (original ?? "").trim()) return;
    try {
      await updateRequest(requestId, { comment: value.trim() || null });
    } catch {
      // ponytail: a failed inline save just leaves the field as typed -
      // the next successful load will reconcile it. Not worth a toast for
      // a single-field autosave on a list of many rows.
    }
  }

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center text-slate-500">Loading...</main>;
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="flex items-center justify-between rounded-[1.4rem] border border-stone-200/80 bg-white/80 px-5 py-4 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-700">Management Portal</p>
          <h1 className="text-xl font-semibold text-slate-950">{user?.displayName ?? user?.username}</h1>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="inline-flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-stone-50"
        >
          <LogOut className="h-4 w-4" /> Sign out
        </button>
      </header>

      <div className="mt-6 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
              tab === t.value
                ? "bg-teal-600 text-white"
                : "border border-stone-300 bg-white text-slate-600 hover:border-slate-400"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto rounded-[1.4rem] border border-stone-200/80 bg-white/80 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
        {error && (
          <p role="alert" className="border-b border-rose-200 bg-rose-50 px-5 py-3 text-sm text-rose-700">
            {error}
          </p>
        )}
        <table className="w-full text-left text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-3">S.No</th>
              <th className="px-5 py-3">File #</th>
              <th className="px-5 py-3">Party</th>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Salesperson</th>
              <th className="px-5 py-3">Delivery</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Comment</th>
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-8 text-center text-slate-500">
                  {tab === "DELIVERED" ? "Nothing delivered yet." : "No requests yet."}
                </td>
              </tr>
            ) : (
              requests.map((r, index) => (
                <tr
                  key={r.id}
                  className="cursor-pointer border-b border-stone-100 transition last:border-none hover:bg-teal-50/40"
                >
                  <td className="px-3 py-3 text-slate-500" onClick={() => router.push(`/management/requests/${r.id}`)}>
                    {index + 1}
                  </td>
                  <td
                    className="px-5 py-3 font-mono text-slate-900"
                    onClick={() => router.push(`/management/requests/${r.id}`)}
                  >
                    {r.file_number}
                  </td>
                  <td className="px-5 py-3 text-slate-900" onClick={() => router.push(`/management/requests/${r.id}`)}>
                    {r.party_name}
                    {r.party_matched === 0 && (
                      <span className="ml-1.5 text-xs font-medium text-amber-700">(other)</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-slate-600" onClick={() => router.push(`/management/requests/${r.id}`)}>
                    {r.file_type.replace(/_/g, " ")}
                  </td>
                  <td className="px-5 py-3 text-slate-600" onClick={() => router.push(`/management/requests/${r.id}`)}>
                    {r.salesperson_name ?? r.salesperson_username}
                  </td>
                  <td className="px-5 py-3 text-slate-600" onClick={() => router.push(`/management/requests/${r.id}`)}>
                    {r.delivery_date}
                  </td>
                  <td className="px-5 py-3" onClick={() => router.push(`/management/requests/${r.id}`)}>
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-5 py-3" onClick={(event) => event.stopPropagation()}>
                    <input
                      value={comments[r.id] ?? ""}
                      onChange={(event) => setComments((prev) => ({ ...prev, [r.id]: event.target.value }))}
                      onBlur={() => handleCommentBlur(r.id, r.comment)}
                      placeholder="Add a note..."
                      className="w-40 cursor-text rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-sm focus:border-teal-500 focus:outline-none"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
