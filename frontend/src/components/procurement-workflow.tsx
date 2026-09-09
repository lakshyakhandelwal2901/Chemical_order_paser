"use client";

import { forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock3,
  Edit3,
  FileDown,
  Layers3,
  Loader2,
  LogOut,
  PackageSearch,
  Printer,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Users,
  Wallet,
  X,
  LayoutDashboard,
  FileSpreadsheet,
} from "lucide-react";
import { clsx } from "clsx";
import { demoChemicals, formatCurrency, matchCustomer } from "@/lib/procurement-demo";
import { requestPricingQuote, uploadPurchaseOrder, uploadQuotationDocument, type ParseOrderResponse, type PricingQuoteResponse } from "@/lib/procurement-api";

type Stage = "login" | "dashboard" | "upload" | "parsing" | "review" | "pricing" | "quotation";
type DocumentMode = "order" | "quotation";

type User = { email: string; name: string };

type LoginForm = { email: string; password: string };

type DraftItem = {
  item_name: string;
  specification: string;
  quantity: string;
  quantity_unit: string;
  unit_rate: string;
  amount: string;
  pack_size: string;
  status: "needs_review" | "confirmed" | "rejected";
  mapped_chemical: string;
};

type RecentOrder = { file: string; customer: string; status: string; total: string; timestamp: string };

const stageOrder: Stage[] = ["login", "dashboard", "upload", "review", "pricing", "quotation"];
const parsingStepsByMode: Record<DocumentMode, string[]> = {
  order: ["Upload received", "Document analyzed", "Order table detected", "Items extracted", "Fields ready for review"],
  quotation: ["Upload received", "Document analyzed", "Quotation table detected", "Items extracted", "Fields ready for review"],
};
const pricingSteps = ["Order approved", "Customer identified", "Rate card checked", "Inventory price fallback ready", "Quotation prepared"];
const supportedUploadTypes = [".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".docx", ".xlsx", ".xls", ".csv", ".txt", ".tsv"];

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stageIndex(stage: Stage) {
  return stageOrder.indexOf(stage);
}

function initialDrafts(order: ParseOrderResponse["data"]) {
  return Object.fromEntries(
    order.items.map((item) => [
      item.item_name,
      {
        item_name: item.item_name,
        specification: item.specification ?? "",
        quantity: item.quantity?.toString() ?? "",
        quantity_unit: item.quantity_unit ?? "",
        unit_rate: item.unit_rate?.toString() ?? "",
        amount: item.amount?.toString() ?? "",
        pack_size: item.pack_size ?? item.quantity_unit ?? "",
        status: "needs_review" as const,
        mapped_chemical: item.item_name,
      },
    ])
  ) as Record<string, DraftItem>;
}

function normalizeRecentOrders(value: unknown): RecentOrder[] {
  return Array.isArray(value) ? (value as RecentOrder[]) : [];
}

export function ProcurementWorkflow() {
  const [stage, setStage] = useState<Stage>("login");
  const [documentMode, setDocumentMode] = useState<DocumentMode>("order");
  const [user, setUser] = useState<User | null>(null);
  const [login, setLogin] = useState<LoginForm>({ email: "", password: "" });
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<ParseOrderResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DraftItem>>({});
  const [customerQuery, setCustomerQuery] = useState("");
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [pricingReport, setPricingReport] = useState<PricingQuoteResponse | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState(parsingStepsByMode.order[0]);
  const [pricingProgress, setPricingProgress] = useState(0);
  const [pricingLabel, setPricingLabel] = useState(pricingSteps[0]);
  const [busy, setBusy] = useState(false);
  const [pricingBusy, setPricingBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement | null>(null);
  const parsingSteps = parsingStepsByMode[documentMode];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedUser = window.sessionStorage.getItem("busyNotify:user");
      const storedOrders = window.localStorage.getItem("busyNotify:recent-orders");

      if (storedUser) {
        try {
          const parsedUser = JSON.parse(storedUser) as User;
          setUser(parsedUser);
          setStage("dashboard");
        } catch {
          window.sessionStorage.removeItem("busyNotify:user");
        }
      }

      if (storedOrders) {
        try {
          setRecentOrders(normalizeRecentOrders(JSON.parse(storedOrders)));
        } catch {
          window.localStorage.removeItem("busyNotify:recent-orders");
        }
      }

      setHydrated(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    window.localStorage.setItem("busyNotify:recent-orders", JSON.stringify(recentOrders));
  }, [hydrated, recentOrders]);

  const currentCustomer = useMemo(() => matchCustomer(customerQuery), [customerQuery]);
  const pricingPreview = useMemo(() => pricingReport?.items ?? [], [pricingReport]);
  const totals = useMemo(() => {
    const subtotal = pricingPreview.reduce((sum, row) => sum + Number(row.quotation.amount ?? 0), 0);
    return { subtotal };
  }, [pricingPreview]);

  const activeStep = stageIndex(stage);

  const resetWorkflow = () => {
    setSelectedFile(null);
    setUploadResult(null);
    setDrafts({});
    setCustomerQuery("");
    setDocumentMode("order");
    setPricingReport(null);
    setProgress(0);
    setProgressLabel(parsingStepsByMode.order[0]);
    setPricingProgress(0);
    setPricingLabel(pricingSteps[0]);
    setBusy(false);
    setPricingBusy(false);
    setNotice(null);
    setError(null);
    setStage(user ? "dashboard" : "login");
  };

  const handleLogin = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!login.email.trim() || !login.password.trim()) {
      setError("Enter email and password to continue.");
      return;
    }

    const nextUser = {
      email: login.email.trim().toLowerCase(),
      name: login.email.split("@")[0].replace(/[._-]/g, " "),
    };

    setUser(nextUser);
    window.sessionStorage.setItem("busyNotify:user", JSON.stringify(nextUser));
    setError(null);
    setNotice("Signed in. Start with the primary New Order action.");
    setStage("dashboard");
  };

  const uploadFile = async (file: File) => {
    const lowerName = file.name.toLowerCase();
    const isSupported = supportedUploadTypes.some((extension) => lowerName.endsWith(extension));
    if (!isSupported) {
      setError("Only PDF, JPG, JPEG, PNG, WebP, GIF, DOCX, XLSX, CSV, TSV, and TXT files are supported for this workflow.");
      return;
    }

    if (!user) {
      setError("Please sign in first.");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    setSelectedFile(file);
    setStage("parsing");
    setProgress(5);
    setProgressLabel(parsingStepsByMode[documentMode][0]);

    const progressTask = (async () => {
      for (let index = 0; index < parsingSteps.length; index += 1) {
        setProgressLabel(parsingSteps[index]);
        setProgress(Math.min(100, 10 + (index + 1) * 18));
        await sleep(220);
      }
    })();

    try {
      const parsed = documentMode === "quotation" ? await uploadQuotationDocument(file, user.email) : await uploadPurchaseOrder(file, user.email);
      await progressTask;
      setUploadResult(parsed);
      setDrafts(initialDrafts(parsed.data));
      setCustomerQuery(parsed.data.issuing_authority ?? parsed.data.vendor_name ?? "");
      setProgress(100);
      setNotice(`Extracted ${parsed.data.items.length} items from the ${documentMode} document. Review every field before pricing.`);
      setStage("review");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : `Failed to parse ${documentMode} document.`);
      setStage("upload");
    } finally {
      setBusy(false);
    }
  };

  const saveDrafts = async (overrideDrafts = drafts) => {
    if (!uploadResult) return;
    // Frontend-only checkpoint for now; backend approval flow can be added later.
    setDrafts(overrideDrafts);
    setNotice("Draft saved. The order can now move to pricing review.");
  };

  const approveAndContinue = async () => {
    if (!uploadResult) return;

    setPricingBusy(true);
    setStage("pricing");
    setPricingProgress(10);
    setPricingLabel(pricingSteps[0]);

    for (let index = 0; index < pricingSteps.length; index += 1) {
      setPricingLabel(pricingSteps[index]);
      setPricingProgress(Math.min(100, 14 + (index + 1) * 16));
      await sleep(220);
    }

    const customerName = currentCustomer?.customer.name ?? customerQuery ?? uploadResult.data.issuing_authority ?? uploadResult.data.vendor_name ?? "";
    const quoteItems = uploadResult.data.items
      .map((item) => ({
        sku: null,
        item_name: drafts[item.item_name]?.mapped_chemical || item.item_name,
        quantity: Number(drafts[item.item_name]?.quantity ?? item.quantity ?? 0),
      }))
      .filter((item) => item.quantity > 0);

    try {
      const quote = await requestPricingQuote(customerName, new Date().toISOString().slice(0, 10), quoteItems);
      setPricingReport(quote);
      setStage("pricing");
      setNotice("Pricing review ready. Prices are flagged only; no price was overwritten.");
    } catch (pricingError) {
      setStage("review");
      setError(pricingError instanceof Error ? pricingError.message : "Pricing review failed. Please retry after checking the backend.");
    } finally {
      setPricingBusy(false);
    }
  };

  const generateQuotation = async () => {
    if (!uploadResult) return;

    setStage("quotation");
    setNotice("Quotation preview ready. Use Print to save as PDF from the browser.");
    await sleep(50);
    if (printRef.current) {
      printRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    const customer = currentCustomer?.customer.name ?? uploadResult.data.issuing_authority ?? uploadResult.data.vendor_name ?? "Unassigned customer";
    const total = formatCurrency(totals.subtotal);
    setRecentOrders((previous) => [
      {
        file: selectedFile?.name ?? uploadResult.filename,
        customer,
        status: "Quotation generated",
        total,
        timestamp: new Date().toISOString(),
      },
      ...previous.filter((entry) => entry.file !== (selectedFile?.name ?? uploadResult.filename)).slice(0, 4),
    ]);
  };

  const handlePrint = () => {
    window.print();
  };

  const selectedCount = uploadResult?.data.items.length ?? 0;
  const itemsNeedingReview = Object.values(drafts).filter((item) => item.status !== "confirmed").length;

  return (
    <main className="min-h-screen text-foreground">
      <div className="relative isolate min-h-screen overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,_rgba(13,148,136,0.16),_transparent_28%),radial-gradient(circle_at_top_right,_rgba(217,119,6,0.14),_transparent_22%),linear-gradient(180deg,_#f8f4ee_0%,_#f3efe7_44%,_#efe9de_100%)]" />
        <div className="absolute left-[-7rem] top-[-8rem] -z-10 h-72 w-72 rounded-full bg-teal-200/35 blur-3xl" />
        <div className="absolute right-[-8rem] top-[16rem] -z-10 h-80 w-80 rounded-full bg-amber-200/30 blur-3xl" />

        {!user ? (
          <section className="mx-auto flex min-h-screen max-w-7xl items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
            <div className="grid w-full gap-6 lg:grid-cols-[1.15fr_0.85fr]">
              <div className="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white/80 p-8 shadow-[0_30px_100px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-12">
                <div className="inline-flex items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-4 py-2 text-sm font-medium text-teal-900">
                  <Sparkles className="h-4 w-4" /> busyNotify Procurement & Quotation System
                </div>
                <div className="mt-8 max-w-2xl space-y-4">
                  <h1 className="text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
                    Move purchase orders from upload to quotation without losing human control.
                  </h1>
                  <p className="text-lg leading-8 text-slate-600">
                    Review the extracted order first, approve it manually, then let pricing and quotation happen in sequence.
                  </p>
                </div>
                <div className="mt-10 grid gap-4 sm:grid-cols-3">
                  {[
                    ["1", "Login", "Secure sign-in before any workflow begins."],
                    ["2", "Review", "Every extracted field stays editable."],
                    ["3", "Quote", "Generate a printable quotation."],
                  ].map(([index, title, description]) => (
                    <div key={title} className="rounded-2xl border border-stone-200 bg-stone-50/80 p-4 shadow-sm">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-sm font-semibold text-white">
                        {index}
                      </div>
                      <h3 className="mt-4 font-semibold text-slate-950">{title}</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-[2rem] border border-stone-200/80 bg-[#0f172a] p-6 shadow-[0_30px_100px_rgba(15,23,42,0.18)] sm:p-8">
                <div className="mb-8 text-center text-white">
                  <p className="text-sm font-medium uppercase tracking-[0.3em] text-teal-200/80">busyNotify</p>
                  <h2 className="mt-3 text-3xl font-semibold tracking-tight">Procurement & Quotation System</h2>
                  <p className="mt-3 text-sm leading-6 text-slate-300">Sign in to start the order-to-quotation workflow.</p>
                </div>
                <form className="space-y-5" onSubmit={handleLogin}>
                  <label className="block space-y-2 text-sm font-medium text-slate-100">
                    <span>Email / Username</span>
                    <input
                      value={login.email}
                      onChange={(event) => setLogin((previous) => ({ ...previous, email: event.target.value }))}
                      placeholder="lakshya@busyNotify.in"
                      className="w-full rounded-2xl border border-white/10 bg-white/8 px-4 py-3 text-white placeholder:text-slate-400 focus:border-teal-300 focus:outline-none"
                    />
                  </label>
                  <label className="block space-y-2 text-sm font-medium text-slate-100">
                    <span>Password</span>
                    <input
                      type="password"
                      value={login.password}
                      onChange={(event) => setLogin((previous) => ({ ...previous, password: event.target.value }))}
                      placeholder="••••••••"
                      className="w-full rounded-2xl border border-white/10 bg-white/8 px-4 py-3 text-white placeholder:text-slate-400 focus:border-teal-300 focus:outline-none"
                    />
                  </label>
                  {error && <p className="rounded-2xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>}
                  <button type="submit" className="flex w-full items-center justify-center gap-2 rounded-2xl bg-teal-500 px-5 py-3.5 font-semibold text-white transition hover:bg-teal-400">
                    Sign In <ArrowRight className="h-4 w-4" />
                  </button>
                </form>
              </div>
            </div>
          </section>
        ) : (
          <div className="mx-auto flex min-h-screen max-w-[1520px] flex-col gap-3 px-4 py-3 sm:px-5 lg:px-6">
            <header className="rounded-[1.4rem] border border-stone-200/80 bg-white/72 px-4 py-2.5 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl lg:px-5">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex items-center gap-3.5">
                  <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-[#0f172a] text-white shadow-lg shadow-slate-900/20">
                    <Layers3 className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-700">busyNotify</p>
                    <h1 className="text-lg font-semibold tracking-tight text-slate-950 sm:text-xl">Procurement & Quotation System</h1>
                    <p className="text-sm text-slate-600">Fast order intake, review, pricing, and quotation generation.</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2">
                    <p className="text-xs font-medium uppercase tracking-[0.25em] text-slate-500">Signed in as</p>
                    <p className="text-sm font-semibold text-slate-950 leading-tight">{user.name}</p>
                    <p className="text-xs text-slate-500">{user.email}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      window.sessionStorage.removeItem("busyNotify:user");
                      setUser(null);
                      resetWorkflow();
                    }}
                    className="inline-flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-stone-50"
                  >
                    <LogOut className="h-4 w-4" /> Sign out
                  </button>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {stageOrder.map((entry) => {
                  const index = stageIndex(entry);
                  const active = index === activeStep;
                  const done = index < activeStep;
                  return (
                    <div
                      key={entry}
                      className={clsx(
                        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition",
                        active ? "border-teal-500 bg-teal-500 text-white" : done ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-stone-200 bg-white text-slate-500"
                      )}
                    >
                      {done ? <CheckCheck className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
                      {entry}
                    </div>
                  );
                })}
              </div>
            </header>

            {notice && <Banner tone="teal" message={notice} />}
            {error && <Banner tone="rose" message={error} />}

            <div className="grid gap-3 xl:grid-cols-[232px_minmax(0,1fr)]">
              <aside className="rounded-[1.4rem] border border-stone-200/80 bg-white/80 p-3 shadow-[0_18px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl">
                <div className="space-y-1 px-1.5 pb-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Navigation</p>
                  <p className="text-sm text-slate-600">Jump between workflow stages.</p>
                </div>
                <nav className="space-y-1">
                  {[
                    ["Dashboard", LayoutDashboard, "dashboard"],
                    ["New Order", UploadCloud, "upload"],
                    ["Orders", FileSpreadsheet, "dashboard"],
                    ["Quotations", FileDown, "quotation"],
                    ["Customers", Users, "pricing"],
                    ["Rate Cards", Wallet, "pricing"],
                    ["Settings", Settings2, "dashboard"],
                  ].map(([label, Icon, target], index) => (
                    <button
                      key={String(label)}
                      type="button"
                      onClick={() => setStage(target as Stage)}
                      className={clsx("flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm transition", index === 1 ? "bg-[#0f172a] text-white shadow-lg shadow-slate-900/10" : "text-slate-700 hover:bg-stone-50")}
                    >
                      <span className="flex items-center gap-3">
                        {Icon ? <Icon className={clsx("h-4 w-4", index === 1 ? "text-teal-200" : "text-slate-500")} /> : null}
                        {String(label)}
                      </span>
                      <ChevronDown className={clsx("h-4 w-4", index === 1 ? "rotate-[-90deg] text-teal-200" : "text-slate-400")} />
                    </button>
                  ))}
                </nav>
                <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50 p-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <ShieldCheck className="h-4 w-4 text-teal-700" /> Workflow status
                  </div>
                  <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
                    <li>• Human review before commercial logic</li>
                    <li>• Editable line items before approval</li>
                    <li>• Pricing review before quotation generation</li>
                  </ul>
                </div>
              </aside>

              <section className="space-y-5">
                {stage === "dashboard" && (
                  <DashboardPane recentOrders={recentOrders} onUpload={(mode) => { setDocumentMode(mode); setStage("upload"); }} />
                )}

                {stage === "upload" && <UploadPane mode={documentMode} busy={busy} selectedFile={selectedFile} onSelectFile={uploadFile} onBack={() => setStage("dashboard")} />}

                {stage === "parsing" && (
                  <ProgressPane title={documentMode === "quotation" ? "Processing Quotation" : "Processing Order"} subtitle="The parser is extracting the table and validating the data before human review." progress={progress} activeLabel={progressLabel} steps={parsingSteps} fileName={selectedFile?.name ?? (documentMode === "quotation" ? "quotation.pdf" : "order.pdf")} />
                )}

                {stage === "review" && uploadResult && (
                  <ReviewPane
                    parseResult={uploadResult}
                    customerQuery={customerQuery}
                    onCustomerChange={setCustomerQuery}
                    drafts={drafts}
                    setDrafts={setDrafts}
                    onSaveDrafts={saveDrafts}
                    onApprove={approveAndContinue}
                    itemsNeedingReview={itemsNeedingReview}
                    selectedCount={selectedCount}
                  />
                )}

                {stage === "pricing" && uploadResult && !pricingReport && (
                  <ProgressPane title="Preparing Quotation" subtitle="Customer lookup, rate-card matching, and pricing review are running now." progress={pricingProgress} activeLabel={pricingLabel} steps={pricingSteps} fileName={selectedFile?.name ?? uploadResult.filename} />
                )}

                {stage === "pricing" && uploadResult && pricingReport && (
                  <PricingPane
                    customerQuery={customerQuery}
                    customerMatch={currentCustomer}
                    pricingPreview={pricingPreview}
                    pricingReport={pricingReport}
                    onGenerateQuotation={generateQuotation}
                    pricingBusy={pricingBusy}
                    totals={totals}
                  />
                )}

                {stage === "quotation" && uploadResult && (
                  <QuotationPane
                    ref={printRef}
                    parseResult={uploadResult}
                    customerQuery={customerQuery}
                    customerMatch={currentCustomer}
                    drafts={drafts}
                    pricingPreview={pricingPreview}
                    pricingReport={pricingReport}
                    totals={totals}
                    onPrint={handlePrint}
                    onNewOrder={() => setStage("upload")}
                  />
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Banner({ tone, message }: { tone: "teal" | "rose"; message: string }) {
  return <div className={clsx("rounded-2xl border px-4 py-3 text-sm shadow-sm", tone === "teal" ? "border-teal-200 bg-teal-50 text-teal-900" : "border-rose-200 bg-rose-50 text-rose-800")}>{message}</div>;
}

function DashboardPane({ recentOrders, onUpload }: { recentOrders: RecentOrder[]; onUpload: (mode: DocumentMode) => void }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
      <div className="rounded-[1.5rem] border border-stone-200/80 bg-[#0f172a] p-5 text-white shadow-[0_30px_100px_rgba(15,23,42,0.18)]">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-200/80">Dashboard</p>
        <h2 className="mt-3 max-w-2xl text-2xl font-semibold tracking-tight sm:text-3xl">Process orders into human-approved quotations.</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">Upload a PO, review the extracted fields, approve the order, then price it before generating the final quotation.</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" onClick={() => onUpload("order")} className="inline-flex items-center gap-2 rounded-2xl bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400">
            <UploadCloud className="h-4 w-4" /> New Order
          </button>
          <button type="button" onClick={() => onUpload("quotation")} className="inline-flex items-center gap-2 rounded-2xl border border-teal-200 bg-teal-50 px-4 py-2.5 text-sm font-semibold text-teal-900 transition hover:bg-teal-100">
            <FileDown className="h-4 w-4" /> New Quotation
          </button>
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-stone-200/80 bg-white/80 p-4 shadow-[0_20px_70px_rgba(15,23,42,0.08)]">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Recent orders</p>
        <div className="mt-3 space-y-2">
          {recentOrders.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-stone-200 bg-stone-50 p-3 text-sm text-slate-500">No quotations yet. Start a new order to generate the first one.</div>
          ) : (
            recentOrders.map((entry) => (
              <div key={`${entry.file}-${entry.timestamp}`} className="rounded-2xl border border-stone-200 bg-stone-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold leading-tight text-slate-950">{entry.file}</p>
                    <p className="truncate text-sm text-slate-500">{entry.customer}</p>
                  </div>
                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700">{entry.status}</span>
                </div>
                <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
                  <span>{entry.total}</span>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function UploadPane({ mode, busy, selectedFile, onSelectFile, onBack }: { mode: DocumentMode; busy: boolean; selectedFile: File | null; onSelectFile: (file: File) => Promise<void>; onBack: () => void }) {
  const [dragging, setDragging] = useState(false);
  const isQuotation = mode === "quotation";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div
        className={clsx(
          "relative min-h-[400px] overflow-hidden rounded-[1.5rem] border border-dashed bg-white/80 p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)]",
          dragging ? "border-teal-500 bg-teal-50" : "border-stone-300"
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (event) => {
          event.preventDefault();
          setDragging(false);
          const [file] = Array.from(event.dataTransfer.files);
          if (file) {
            await onSelectFile(file);
          }
        }}
      >
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp,image/gif,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,text/plain,text/tab-separated-values,.pdf,.jpg,.jpeg,.png,.webp,.gif,.docx,.xlsx,.xls,.csv,.txt,.tsv"
          className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
          disabled={busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) {
              await onSelectFile(file);
            }
          }}
        />
        <div className="pointer-events-none flex h-full flex-col items-center justify-center text-center">
          <div className="flex h-18 w-18 items-center justify-center rounded-[1.75rem] bg-[#0f172a] text-white shadow-lg shadow-slate-900/20">{busy ? <Loader2 className="h-7 w-7 animate-spin" /> : <UploadCloud className="h-7 w-7" />}</div>
          <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-950">Drop {isQuotation ? "quotation" : "order"} document here</h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">Upload the {isQuotation ? "quotation" : "purchase order"} document and the backend will parse it.</p>
          <button type="button" className="mt-4 rounded-2xl bg-teal-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-400">Browse Files</button>
          <p className="mt-2.5 text-sm text-slate-500">PDF, images, DOCX, XLSX, CSV, TSV, and TXT supported.</p>
          {selectedFile && <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800"><CheckCircle2 className="h-4 w-4" /> <span className="truncate">{selectedFile.name}</span></div>}
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-stone-200/80 bg-[#0f172a] p-4 text-white shadow-[0_20px_70px_rgba(15,23,42,0.14)]">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-200/80">Workflow</p>
        <h3 className="mt-2 text-lg font-semibold">{isQuotation ? "Quotation intake" : "Order intake"}</h3>
        <div className="mt-3 space-y-2.5">
          {[["Step 1", "Upload", `Select the ${isQuotation ? "quotation" : "order"} document.`], ["Step 2", "Review", "Edit every extracted field."], ["Step 3", "Quotation", "Apply pricing and generate the PDF."]].map(([step, title, detail], index) => (
            <div key={title} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
              <div className={clsx("flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold", index === 0 ? "bg-teal-500 text-white" : "bg-white/10 text-white")}>{index === 0 ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}</div>
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">{step}</p>
                <p className="mt-0.5 font-semibold">{title}</p>
                <p className="mt-0.5 text-sm leading-5 text-slate-300">{detail}</p>
              </div>
            </div>
          ))}
        </div>
        <button type="button" onClick={onBack} className="mt-4 inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/10 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/15">
          <ArrowLeft className="h-4 w-4" /> Back to dashboard
        </button>
      </div>
    </div>
  );
}

function ProgressPane({ title, subtitle, progress, activeLabel, steps, fileName }: { title: string; subtitle: string; progress: number; activeLabel: string; steps: string[]; fileName: string; }) {
  return (
    <div className="rounded-[1.5rem] border border-stone-200/80 bg-white/80 p-6 shadow-[0_20px_70px_rgba(15,23,42,0.08)]">
      <div className="max-w-3xl">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">{title}</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">{fileName}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{subtitle}</p>
      </div>
      <div className="mt-6 grid gap-2.5 lg:grid-cols-2 xl:grid-cols-3">
        {steps.map((step, index) => (
          <div key={step} className="flex items-center gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-3 py-2.5">
            {progress > index * 16 ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Clock3 className="h-4 w-4 text-amber-600" />}
            <span className="text-sm leading-tight text-slate-700">{step}</span>
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-2xl border border-stone-200 bg-stone-50 p-4">
        <div className="mb-3 flex items-center justify-between text-sm text-slate-600">
          <span>Validating extracted data</span>
          <span>{progress}%</span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-stone-200">
          <div className="h-full rounded-full bg-gradient-to-r from-teal-500 via-amber-400 to-teal-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-3 text-sm font-medium text-slate-800">{activeLabel}</p>
      </div>
    </div>
  );
}

function ReviewPane({
  parseResult,
  customerQuery,
  onCustomerChange,
  drafts,
  setDrafts,
  onSaveDrafts,
  onApprove,
  itemsNeedingReview,
  selectedCount,
}: {
  parseResult: ParseOrderResponse;
  customerQuery: string;
  onCustomerChange: (value: string) => void;
  drafts: Record<string, DraftItem>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, DraftItem>>>;
  onSaveDrafts: (overrideDrafts?: Record<string, DraftItem>) => Promise<void>;
  onApprove: () => Promise<void>;
  itemsNeedingReview: number;
  selectedCount: number;
}) {
  const [expandedItem, setExpandedItem] = useState<string | null>(parseResult.data.items[0]?.item_name ?? null);
  const customerMatch = matchCustomer(customerQuery);

  return (
    <div className="space-y-2.5">
      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-[1.25rem] border border-stone-200/80 bg-white/80 p-3 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Review Order</p>
          <h2 className="mt-1.5 text-lg font-semibold tracking-tight text-slate-950 sm:text-xl">Step 2/3</h2>
          <p className="mt-1 text-sm text-slate-600">Inspect and edit only the row you need before pricing begins.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Source file" value={parseResult.filename} />
            <Tile label="Parser source" value={parseResult.source} />
            <Tile label="Document type" value={parseResult.data.document_type} />
            <Tile label="Customer guess" value={parseResult.data.issuing_authority ?? "-"} />
          </div>
        </div>

        <div className="rounded-[1.25rem] border border-stone-200/80 bg-[#0f172a] p-3 text-white shadow-[0_16px_50px_rgba(15,23,42,0.14)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-200/80">Customer</p>
          <label className="mt-2 block text-sm font-medium text-slate-100">
            Customer / Account
            <div className="mt-1.5 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/10 px-3 py-2">
              <Search className="h-4 w-4 text-slate-300" />
              <input value={customerQuery} onChange={(event) => onCustomerChange(event.target.value)} placeholder="Start typing a customer name" className="w-full bg-transparent text-white placeholder:text-slate-400 focus:outline-none" />
            </div>
          </label>
          <div className="mt-2.5 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-300">
            <div className="flex items-center gap-2 text-white"><BadgeCheck className="h-4 w-4 text-teal-300" /> Match status</div>
            <p className="mt-2.5 leading-6">
              {customerMatch
                ? `${customerMatch.customer.name} matched via ${customerMatch.source} lookup (${Math.round(customerMatch.score * 100)}%).`
                : "No customer match yet. Type a customer name to continue."}
            </p>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-2.5">
            <StatChip label="Items" value={selectedCount.toString()} />
            <StatChip label="Needs review" value={itemsNeedingReview.toString()} />
            <StatChip label="Rate cards" value={customerMatch?.customer.rateCardId ? "1" : "0"} />
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-[1.1rem] border border-stone-200/80 bg-white/80 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
        <div className="hidden border-b border-stone-200 bg-stone-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:grid xl:grid-cols-[minmax(0,1fr)_68px_104px_96px] xl:gap-2">
          <span>Line item</span>
          <span>Qty</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        <div className="space-y-1 p-1.5">
        {parseResult.data.items.map((item, index) => (
          <ItemEditor
            key={`${item.item_name}-${index}`}
            index={index + 1}
            item={item}
            draft={drafts[item.item_name]}
            isExpanded={expandedItem === item.item_name}
            onToggleExpanded={() => setExpandedItem((previous) => (previous === item.item_name ? null : item.item_name))}
            onChange={(patch) =>
              setDrafts((previous) => ({
                ...previous,
                [item.item_name]: { ...previous[item.item_name], ...patch },
              }))
            }
          />
        ))}
        </div>
      </div>

      <div className="grid gap-2.5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="rounded-[1.25rem] border border-stone-200/80 bg-white/80 p-3 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Review checkpoint</p>
          <p className="mt-1.5 text-sm leading-6 text-slate-600">Confirm the extracted fields before pricing or quotation generation.</p>
        </div>
        <div className="rounded-[1.25rem] border border-stone-200/80 bg-[#0f172a] p-3 text-white shadow-[0_16px_50px_rgba(15,23,42,0.14)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-200/80">Workflow action</p>
          <h3 className="mt-1.5 text-lg font-semibold">Approve only after the review is clean.</h3>
          <div className="mt-3.5 flex flex-col gap-2.5">
            <button type="button" onClick={() => onSaveDrafts(drafts)} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold transition hover:bg-white/15">
              <Edit3 className="h-4 w-4" /> Save Draft
            </button>
            <button type="button" onClick={onApprove} className="inline-flex items-center justify-center gap-2 rounded-2xl bg-teal-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-400">
              <ArrowRight className="h-4 w-4" /> Approve &amp; Continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ItemEditor({
  index,
  item,
  draft,
  isExpanded,
  onToggleExpanded,
  onChange,
}: {
  index: number;
  item: ParseOrderResponse["data"]["items"][number];
  draft: DraftItem;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<DraftItem>) => void;
}) {
  const [query, setQuery] = useState(() => draft?.mapped_chemical ?? item.item_name);
  const matches = demoChemicals.filter((chemical) => chemical.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  return (
    <div className="rounded-[1.05rem] border border-stone-200/80 bg-white/80 p-2.5 shadow-[0_14px_40px_rgba(15,23,42,0.07)]">
      <button type="button" onClick={onToggleExpanded} className="grid w-full gap-2 text-left xl:grid-cols-[minmax(0,1fr)_68px_104px_96px] xl:items-center">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">Line item {index}</p>
          <h3 className="mt-0.5 text-[15px] font-semibold leading-tight text-slate-950">{draft?.mapped_chemical ?? item.item_name}</h3>
          <p className="mt-1 text-[10px] text-slate-500">{item.pack_size || item.quantity_unit || "-"}</p>
        </div>
        <div className="xl:text-right">
          <p className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:block">Qty</p>
          <p className="text-sm font-semibold text-slate-950">{draft?.quantity ?? item.quantity?.toString() ?? "-"}</p>
          <p className="text-[10px] text-slate-500">{item.quantity_unit || "Numbers"}</p>
        </div>
        <div className="xl:text-center">
          <p className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:block">Status</p>
          <span className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold", draft?.status === "confirmed" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : draft?.status === "rejected" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-amber-200 bg-amber-50 text-amber-800")}>
            {draft?.status === "confirmed" ? <CheckCircle2 className="h-3 w-3" /> : draft?.status === "rejected" ? <X className="h-3 w-3" /> : <Clock3 className="h-3 w-3" />}
            {draft?.status === "confirmed" ? "Confirmed" : draft?.status === "rejected" ? "Rejected" : "Review"}
          </span>
        </div>
        <div className="flex items-center justify-end gap-2 xl:justify-end">
          <span className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:block">Review</span>
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-slate-500">{isExpanded ? <ChevronDown className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}</span>
        </div>
      </button>

      {isExpanded && (
        <div className="mt-2.5 space-y-2.5 border-t border-stone-200 pt-2.5">
          <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-6">
            <Field label="Item Name">
              <input value={draft?.item_name ?? item.item_name} onChange={(event) => onChange({ item_name: event.target.value })} className="w-full rounded-2xl border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-teal-400" />
            </Field>
            <Field label="Quantity">
              <input value={draft?.quantity ?? item.quantity?.toString() ?? ""} onChange={(event) => onChange({ quantity: event.target.value })} className="w-full rounded-2xl border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-teal-400" />
            </Field>
            <Field label="Unit">
              <input value={draft?.quantity_unit ?? item.quantity_unit ?? ""} onChange={(event) => onChange({ quantity_unit: event.target.value })} className="w-full rounded-2xl border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-teal-400" />
            </Field>
            <Field label="Unit Rate">
              <input value={draft?.unit_rate ?? item.unit_rate?.toString() ?? ""} onChange={(event) => onChange({ unit_rate: event.target.value })} className="w-full rounded-2xl border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-teal-400" />
            </Field>
          </div>

          <div className="grid gap-2 xl:grid-cols-[minmax(0,1fr)_220px]">
            <Field label="Map to chemical">
              <div className="relative">
                <div className="flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-slate-900">
                  <PackageSearch className="h-4 w-4 text-slate-400" />
                  <input value={query} onChange={(event) => { setQuery(event.target.value); onChange({ mapped_chemical: event.target.value }); }} placeholder="Search chemical master" className="w-full bg-transparent outline-none placeholder:text-slate-400" />
                </div>
                {matches.length > 0 && (
                  <div className="absolute z-20 mt-2 max-h-36 w-full overflow-auto rounded-2xl border border-stone-200 bg-white shadow-[0_20px_70px_rgba(15,23,42,0.12)]">
                    {matches.map((chemical) => (
                      <button
                        key={chemical}
                        type="button"
                        onMouseDown={(event) => {
                          event.preventDefault();
                          setQuery(chemical);
                          onChange({ mapped_chemical: chemical });
                        }}
                        className="flex w-full items-center justify-between border-b border-stone-100 px-3 py-1.5 text-left text-sm text-slate-700 last:border-b-0 hover:bg-stone-50"
                      >
                        <span>{chemical}</span>
                        <span className="text-slate-500">Match</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </Field>
            <Field label="Status">
              <select value={draft?.status ?? "needs_review"} onChange={(event) => onChange({ status: event.target.value as DraftItem["status"] })} className="w-full rounded-2xl border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-slate-900 outline-none transition focus:border-teal-400">
                <option value="needs_review">needs_review</option>
                <option value="confirmed">confirmed</option>
                <option value="rejected">rejected</option>
              </select>
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function PricingPane({
  customerQuery,
  customerMatch,
  pricingPreview,
  pricingReport,
  onGenerateQuotation,
  pricingBusy,
  totals,
}: {
  customerQuery: string;
  customerMatch: ReturnType<typeof matchCustomer>;
  pricingPreview: PricingQuoteResponse["items"];
  pricingReport: PricingQuoteResponse | null;
  onGenerateQuotation: () => Promise<void>;
  pricingBusy: boolean;
  totals: { subtotal: number };
}) {
  const customer = customerMatch?.customer;
  const priceFlags = pricingPreview.filter((row) => row.price_review.needs_review);
  const shortages = pricingPreview.filter((row) => row.shortfall > 0);
  const [expandedRow, setExpandedRow] = useState<string | null>(pricingPreview[0]?.item_name ?? null);

  useEffect(() => {
    setExpandedRow(pricingPreview[0]?.item_name ?? null);
  }, [pricingPreview]);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_300px]">
        <div className="rounded-[1.35rem] border border-stone-200/80 bg-white/80 p-3.5 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Pricing review</p>
          <h3 className="mt-1.5 text-lg font-semibold text-slate-950">Review-only pricing and stock check</h3>
          <p className="mt-1 text-sm leading-6 text-slate-600">The system only flags differences. It does not rewrite prices here.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <Tile label="Customer" value={customer?.name ?? (customerQuery || "Unassigned")} />
            <Tile label="Rate Card" value={customer?.rateCardId ?? "Not linked"} />
            <Tile label="Valid" value={customer?.validFrom && customer?.validTo ? `${customer.validFrom} → ${customer.validTo}` : "—"} />
          </div>
        </div>

        <div className="rounded-[1.35rem] border border-stone-200/80 bg-[#0f172a] p-3.5 text-white shadow-[0_16px_50px_rgba(15,23,42,0.14)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-200/80">Review summary</p>
          <div className="mt-2 space-y-2 text-sm text-slate-300">
            <LegendItem tone="teal" label="Price lower than inventory" description="Flag the row, but do not auto-adjust the price." />
            <LegendItem tone="slate" label="Price higher than inventory" description="Flag the row, but keep the original value visible." />
            <LegendItem tone="teal" label="Inventory shortage" description="Flag the missing quantity so procurement can order it." />
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Tile label="Rows with price flags" value={String(priceFlags.length)} />
        <Tile label="Rows with shortage" value={String(shortages.length)} />
        <Tile label="Units short" value={String(pricingReport?.summary.total_shortfall ?? 0)} />
      </div>

      <div className="overflow-hidden rounded-[1.1rem] border border-stone-200/80 bg-white/80 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
        <div className="hidden border-b border-stone-200 bg-stone-50 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:grid xl:grid-cols-[minmax(0,1.55fr)_92px_92px_92px_68px_90px_140px_104px_96px] xl:gap-2">
          <span>Line item</span><span>Inventory price</span><span>Rate card price</span><span>Reviewed quote</span><span>Qty</span><span>Difference</span><span>Inventory review</span><span>Status</span><span>Actions</span>
        </div>
        <div className="space-y-1 p-1.5">
          {pricingPreview.filter(Boolean).map((row, index) => {
            const inventoryPrice = row.inventory?.unit_price ?? null;
            const reviewedQuote = row.quotation?.unit_price ?? null;
            const rateCardPrice = row.pricing?.rate ?? null;
            const shortfall = Number(row.shortfall ?? 0);
            const statusLabel = shortfall > 0 ? "Inventory shortage" : row.price_review.needs_review ? "Price review" : "No flag";
            return (
              <div key={`${row.sku ?? row.item_name}-${index}`} className="overflow-hidden rounded-[1rem] border border-stone-200/80 bg-white/80">
                <button type="button" onClick={() => setExpandedRow((previous) => (previous === row.item_name ? null : row.item_name))} className="grid w-full gap-2 px-3 py-2.5 text-left xl:grid-cols-[minmax(0,1.55fr)_92px_92px_92px_68px_90px_140px_104px_96px] xl:items-center">
                  <div className="min-w-0">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">Line item {index + 1}</p>
                    <h3 className="mt-0.5 truncate text-[14px] font-semibold leading-tight text-slate-950">{row.item_name}</h3>
                    <p className="mt-0.5 text-[10px] text-slate-500">{row.sku ?? "No SKU"}</p>
                  </div>
                  <PriceCell label="Inventory price" value={inventoryPrice} />
                  <PriceCell label="Rate card price" value={rateCardPrice} />
                  <PriceCell label="Reviewed quote" value={reviewedQuote} />
                  <PriceCell label="Qty" value={row.requested_quantity} plain />
                  <div className="xl:text-right">
                    <p className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:block">Difference</p>
                    <p className="text-sm font-semibold text-slate-950">{row.price_review.difference === null ? "—" : formatCurrency(row.price_review.difference)}</p>
                    <p className="text-[10px] text-slate-500">{row.price_review.comparison}</p>
                  </div>
                  <div className={clsx("text-center text-[10px] font-semibold", row.available ? "text-emerald-700" : "text-amber-800")}>
                    <p className="hidden uppercase tracking-[0.18em] xl:block">Inventory review</p>
                    <p>{row.available ? "Available" : shortfall > 0 ? `Short by ${shortfall}` : "Not found"}</p>
                    <p className="font-normal text-slate-500">{row.available_quantity} available</p>
                  </div>
                  <div className={clsx("inline-flex items-center justify-center rounded-full px-2.5 py-1 text-[10px] font-semibold", shortfall > 0 || row.price_review.needs_review ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700")}>{statusLabel}</div>
                  <span className="flex items-center justify-end gap-2 text-xs font-semibold text-slate-700"><span className="hidden xl:inline">Review</span>{expandedRow === row.item_name ? <ChevronDown className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}</span>
                </button>
                {expandedRow === row.item_name && (
                  <div className="grid gap-2 border-t border-stone-200 px-3 py-3 md:grid-cols-2">
                    <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3 text-sm text-slate-700">
                      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Price review</p>
                      <p className="mt-1.5 leading-6">{row.price_review.message}</p>
                    </div>
                    <div className={clsx("rounded-2xl border p-3 text-sm", row.available ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900")}>
                      <p className="text-xs font-semibold uppercase tracking-[0.25em]">Inventory review</p>
                      <p className="mt-1.5 leading-6">{row.available ? "Enough inventory on hand for the requested quantity." : shortfall > 0 ? `Short by ${shortfall}. Need to order this quantity before fulfillment.` : "Item could not be matched in inventory; review required."}</p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-[1.1rem] border border-stone-200/80 bg-white/80 p-3 shadow-[0_16px_50px_rgba(15,23,42,0.08)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Pricing notes</p>
          <p className="mt-1.5 text-sm leading-6 text-slate-600">This screen is review-only. Prices are shown and flagged, but not edited here.</p>
        </div>
        <div className="rounded-[1.1rem] border border-stone-200/80 bg-[#0f172a] p-3 text-white shadow-[0_16px_50px_rgba(15,23,42,0.14)]">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-200/80">Quoted total</p>
          <div className="mt-2 text-2xl font-semibold">{formatCurrency(totals.subtotal)}</div>
          <p className="mt-1.5 text-sm text-slate-300">Based on the reviewed quote returned by the mock API.</p>
          <button type="button" onClick={onGenerateQuotation} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-teal-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-400">
            <FileDown className="h-4 w-4" /> {pricingBusy ? "Generating..." : "Generate Quotation"}
          </button>
        </div>
      </div>
    </div>
  );
}

const LegendItem = ({ tone, label, description }: { tone: "teal" | "slate"; label: string; description: string }) => (
  <div className="flex gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
    <div className={clsx("mt-1 h-2.5 w-2.5 rounded-full", tone === "teal" ? "bg-teal-400" : "bg-slate-400")} />
    <div>
      <p className="font-semibold text-white">{label}</p>
      <p className="mt-0.5 text-sm leading-5 text-slate-300">{description}</p>
    </div>
  </div>
);

const Tile = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-2xl border border-stone-200 bg-stone-50 p-2.5">
    <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-slate-500">{label}</p>
    <p className="mt-1 text-sm font-semibold leading-tight text-slate-950">{value}</p>
  </div>
);

const PriceCell = ({ label, value, plain = false }: { label: string; value: number | null; plain?: boolean }) => (
  <div className="xl:text-right">
    <p className="hidden text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500 xl:block">{label}</p>
    <p className="text-sm font-semibold text-slate-950">{plain ? value : value === null ? "—" : formatCurrency(value)}</p>
  </div>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block space-y-1.5">
    <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-500">{label}</span>
    {children}
  </label>
);

const StatChip = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-white">
    <p className="text-xs uppercase tracking-[0.25em] text-slate-400">{label}</p>
    <p className="mt-0.5 text-base font-semibold">{value}</p>
  </div>
);

const QuotationPane = forwardRef<HTMLDivElement, {
  parseResult: ParseOrderResponse;
  customerQuery: string;
  customerMatch: ReturnType<typeof matchCustomer>;
  drafts: Record<string, DraftItem>;
  pricingPreview: PricingQuoteResponse["items"];
  pricingReport: PricingQuoteResponse | null;
  totals: { subtotal: number };
  onPrint: () => void;
  onNewOrder: () => void;
}>(({ parseResult, customerQuery, customerMatch, drafts, pricingPreview, pricingReport, totals, onPrint, onNewOrder }, ref) => {
  const customer = customerMatch?.customer;
  return (
    <div ref={ref} className="space-y-5">
      <div className="flex flex-col gap-4 rounded-[1.75rem] border border-stone-200/80 bg-white/80 p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] lg:flex-row lg:items-center lg:justify-between print:shadow-none">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">Quotation preview</p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-950">Quotation #{parseResult.filename.replace(/\.[^.]+$/, "").toUpperCase()}</h3>
          <p className="mt-2 text-sm text-slate-600">Review the generated quotation and print or save it as PDF from the browser.</p>
        </div>
        <div className="flex flex-wrap gap-3 print:hidden">
          <button type="button" onClick={onPrint} className="inline-flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-stone-50">
            <Printer className="h-4 w-4" /> Print
          </button>
          <button type="button" onClick={onNewOrder} className="inline-flex items-center gap-2 rounded-2xl bg-teal-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-400">
            <UploadCloud className="h-4 w-4" /> New Order
          </button>
        </div>
      </div>

      <div className="rounded-[1.5rem] border border-stone-200/80 bg-white/80 p-5 shadow-[0_20px_70px_rgba(15,23,42,0.08)] print:bg-white" >
        <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <div className="text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-700">YOUR COMPANY</p>
              <h4 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Chemical &amp; Laboratory Supplies</h4>
            </div>
            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <Tile label="To" value={customer?.name ?? (customerQuery || parseResult.data.issuing_authority || "Unassigned")} />
              <Tile label="Quotation date" value={new Date().toLocaleDateString("en-IN")} />
              <Tile label="Reference PO" value={parseResult.data.order_number ?? "-"} />
              <Tile label="Vendor" value={parseResult.data.vendor_name ?? "-"} />
            </div>
            <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200 bg-white">
              <table className="w-full text-[11px] md:text-sm">
                <thead className="bg-stone-100 text-left text-slate-600">
                  <tr>
                    <th className="px-2.5 py-2">#</th>
                    <th className="px-2.5 py-2">Item</th>
                    <th className="px-2.5 py-2">Qty</th>
                    <th className="px-2.5 py-2">Rate</th>
                    <th className="px-2.5 py-2">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingPreview.map((row, index) => {
                    const quantity = Number(drafts[row.item_name]?.quantity ?? 0) || 0;
                    const amount = Number(row.quotation.amount ?? quantity * Number(row.quotation.unit_price ?? 0));
                    return (
                      <tr key={`${row.sku ?? row.item_name}-${index}`} className="border-t border-stone-200 align-top odd:bg-stone-50/30">
                        <td className="px-2.5 py-2">{index + 1}</td>
                        <td className="px-2.5 py-2 leading-tight">{row.item_name}</td>
                        <td className="px-2.5 py-2">{quantity}</td>
                        <td className="px-2.5 py-2">{formatCurrency(row.quotation.unit_price)}</td>
                        <td className="px-2.5 py-2">{formatCurrency(amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="space-y-3">
            <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Quotation summary</p>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <SummaryRow label="Customer" value={customer?.name ?? (customerQuery || parseResult.data.issuing_authority || "Unassigned")} />
                <SummaryRow label="Order" value={parseResult.filename} />
                <SummaryRow label="Items" value={String(pricingPreview.length)} />
                <SummaryRow label="Subtotal" value={formatCurrency(totals.subtotal)} />
                <SummaryRow label="Items short" value={String(pricingReport?.summary.inventory_short_items ?? 0)} />
                <SummaryRow label="Needs review" value={String(pricingReport?.summary.needs_review ?? 0)} />
              </div>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-[#0f172a] p-3 text-white">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-teal-200/80">Pricing source</p>
              <div className="mt-3 space-y-1.5 text-sm text-slate-300">
                <div>• Customer rate card is compared against inventory and flagged when different</div>
                <div>• Shortages are shown with the quantity that needs to be ordered</div>
                <div>• No prices are changed in this screen</div>
              </div>
            </div>
            <div className="rounded-2xl border border-stone-200 bg-white p-3 text-sm text-slate-600">
              This is a browser-native quotation preview. The server-side PDF generator can be attached later without changing the workflow.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
QuotationPane.displayName = "QuotationPane";

const SummaryRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-3 rounded-2xl bg-white px-3 py-1.5">
    <span>{label}</span>
    <span className="font-semibold text-slate-900">{value}</span>
  </div>
);
