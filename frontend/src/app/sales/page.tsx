"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LogOut, UploadCloud, CheckCircle2, Search } from "lucide-react";
import { getCurrentUser, logout, type SessionUser } from "@/lib/auth-api";
import { submitRequest, searchRateContractParties, type RequestType } from "@/lib/procurement-api";

function defaultDeliveryDate() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().slice(0, 10);
}

const REQUEST_TYPES: { value: RequestType; label: string }[] = [
  { value: "ORDER", label: "Order" },
  { value: "RATE_CONTRACT", label: "Rate Contract" },
  { value: "QUOTATION", label: "Quotation" },
];

export default function SalesPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const [partyName, setPartyName] = useState("");
  const [requestType, setRequestType] = useState<RequestType>("ORDER");
  const [file, setFile] = useState<File | null>(null);
  const [deliveryDate, setDeliveryDate] = useState(defaultDeliveryDate);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // Rate-contract party search-as-you-type, like a search engine's
  // suggestion dropdown: type a few letters, get matching known parties,
  // pick one (or "Other" if nothing matches) before submitting is allowed.
  const [partyMatched, setPartyMatched] = useState<boolean | undefined>(undefined);
  const [partySuggestions, setPartySuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const blurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (requestType !== "RATE_CONTRACT" || !partyName.trim()) {
      setPartySuggestions([]);
      return;
    }
    const handle = setTimeout(() => {
      searchRateContractParties(partyName.trim())
        .then(setPartySuggestions)
        .catch(() => setPartySuggestions([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [partyName, requestType]);

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  function resetForm() {
    setPartyName("");
    setRequestType("ORDER");
    setFile(null);
    setDeliveryDate(defaultDeliveryDate());
    setPartyMatched(undefined);
    setPartySuggestions([]);
    setConfirmation(null);
    setError(null);
  }

  function handlePartyNameChange(value: string) {
    setPartyName(value);
    setPartyMatched(undefined); // typing invalidates whatever was previously selected
    setShowSuggestions(true);
  }

  function selectParty(name: string) {
    setPartyName(name);
    setPartyMatched(true);
    setShowSuggestions(false);
  }

  function selectOther() {
    setPartyMatched(false);
    setShowSuggestions(false);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!partyName.trim()) {
      setError("Enter the party name.");
      return;
    }
    if (requestType === "RATE_CONTRACT" && partyMatched === undefined) {
      setError("Search for the party and select it from the list, or choose \"Other\" if it's not listed.");
      return;
    }
    if (!file) {
      setError("Choose a file to upload.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await submitRequest({
        file,
        partyName: partyName.trim(),
        requestType,
        deliveryDate,
        partyMatched: requestType === "RATE_CONTRACT" ? partyMatched : undefined,
      });
      setConfirmation(result.file_number);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <main className="flex min-h-screen items-center justify-center text-slate-500">Loading...</main>;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="flex items-center justify-between rounded-[1.4rem] border border-stone-200/80 bg-white/80 px-5 py-4 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-700">Sales Portal</p>
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

      {confirmation ? (
        <div className="mt-6 rounded-[1.4rem] border border-teal-200 bg-teal-50 p-8 text-center shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
          <CheckCircle2 className="mx-auto h-10 w-10 text-teal-600" />
          <p className="mt-4 text-lg font-semibold text-slate-950">Request submitted</p>
          <p className="mt-1 text-sm text-slate-600">
            Reference number: <span className="font-mono font-semibold">{confirmation}</span>
          </p>
          <button
            type="button"
            onClick={resetForm}
            className="mt-6 rounded-2xl bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-500"
          >
            Submit another request
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="mt-6 space-y-5 rounded-[1.4rem] border border-stone-200/80 bg-white/80 p-6 shadow-[0_18px_60px_rgba(15,23,42,0.08)]"
        >
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Salesperson</p>
            <p className="text-sm font-semibold text-slate-950">{user?.displayName ?? user?.username}</p>
          </div>

          <div className="relative">
            <label className="block space-y-1.5 text-sm font-medium text-slate-800">
              <span>Party Name</span>
              {requestType === "RATE_CONTRACT" ? (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={partyName}
                    onChange={(event) => handlePartyNameChange(event.target.value)}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => {
                      blurTimeout.current = setTimeout(() => setShowSuggestions(false), 150);
                    }}
                    placeholder="Search for the party..."
                    autoComplete="off"
                    className="w-full rounded-xl border border-stone-300 bg-white py-2.5 pl-9 pr-4 text-slate-950 focus:border-teal-500 focus:outline-none"
                  />
                </div>
              ) : (
                <input
                  value={partyName}
                  onChange={(event) => setPartyName(event.target.value)}
                  placeholder="ABC Hospital"
                  className="w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-slate-950 focus:border-teal-500 focus:outline-none"
                />
              )}
            </label>

            {requestType === "RATE_CONTRACT" && showSuggestions && (
              <div
                onMouseDown={(event) => {
                  // beats the input's onBlur so the click below actually registers
                  event.preventDefault();
                  if (blurTimeout.current) clearTimeout(blurTimeout.current);
                }}
                className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
              >
                {partySuggestions.length > 0 ? (
                  partySuggestions.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => selectParty(name)}
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-slate-800 hover:bg-teal-50"
                    >
                      <Search className="h-3.5 w-3.5 text-slate-400" /> {name}
                    </button>
                  ))
                ) : (
                  <p className="px-4 py-2.5 text-sm text-slate-500">
                    {partyName.trim() ? "No matching party found." : "Start typing to search known parties."}
                  </p>
                )}
                <button
                  type="button"
                  onClick={selectOther}
                  className="w-full border-t border-stone-100 px-4 py-2.5 text-left text-sm font-medium text-teal-700 hover:bg-teal-50"
                >
                  Other — not in the list
                </button>
              </div>
            )}

            {requestType === "RATE_CONTRACT" && partyMatched === true && (
              <p className="mt-1 text-xs font-medium text-teal-700">Matched known party.</p>
            )}
            {requestType === "RATE_CONTRACT" && partyMatched === false && (
              <p className="mt-1 text-xs font-medium text-amber-700">Marked as Other — not a known party.</p>
            )}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-800">Request Type</legend>
            <div className="flex flex-wrap gap-3">
              {REQUEST_TYPES.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-xl border px-4 py-2 text-sm font-medium transition ${
                    requestType === option.value
                      ? "border-teal-500 bg-teal-50 text-teal-800"
                      : "border-stone-300 bg-white text-slate-600 hover:border-slate-400"
                  }`}
                >
                  <input
                    type="radio"
                    name="request_type"
                    value={option.value}
                    checked={requestType === option.value}
                    onChange={() => {
                      setRequestType(option.value);
                      setPartyMatched(undefined);
                      setShowSuggestions(false);
                    }}
                    className="sr-only"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="block space-y-1.5 text-sm font-medium text-slate-800">
            <span>Upload File</span>
            <span className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-4 py-8 text-center transition hover:border-teal-400 hover:bg-teal-50/40">
              <UploadCloud className="h-6 w-6 text-slate-400" />
              <span className="text-sm text-slate-600">{file ? file.name : "Click to choose a file"}</span>
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.docx,.doc,.xlsx,.xls,.csv,.txt"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="sr-only"
              />
            </span>
          </label>

          <label className="block space-y-1.5 text-sm font-medium text-slate-800">
            <span>Delivery Date</span>
            <input
              type="date"
              value={deliveryDate}
              onChange={(event) => setDeliveryDate(event.target.value)}
              className="w-full rounded-xl border border-stone-300 bg-white px-4 py-2.5 text-slate-950 focus:border-teal-500 focus:outline-none"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-2xl bg-teal-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Submitting..." : "Submit"}
          </button>
        </form>
      )}
    </main>
  );
}
