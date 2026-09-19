import { ProcurementWorkflow } from "@/components/procurement-workflow";

// ponytail: this is the pre-Phase-1 single-user demo flow (fake client-side
// login, no roles, shows pricing/stock to whoever uploads). It used to be
// mounted at "/". Moved here, ungated, purely so its upload/review/pricing
// JSX can be cannibalized while building the real Sales (Phase 2) and
// Management (Phase 5) screens. Delete this route once those exist.
export default function LegacyDemoPage() {
  return <ProcurementWorkflow />;
}
