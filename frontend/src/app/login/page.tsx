"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { login, dashboardPathForRole } from "@/lib/auth-api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("Enter both a username and password.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { user } = await login(username.trim(), password);
      router.push(dashboardPathForRole(user.role));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-[2rem] border border-stone-200/80 bg-[#0f172a] p-8 shadow-[0_30px_100px_rgba(15,23,42,0.18)] sm:p-10">
        <div className="mb-8 text-center text-white">
          <p className="text-sm font-medium uppercase tracking-[0.3em] text-teal-200/80">busyNotify</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Chemical Order System</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">Sign in to continue.</p>
        </div>
        <form className="space-y-5" onSubmit={handleSubmit}>
          <label className="block space-y-2 text-sm font-medium text-slate-100">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="rohit"
              autoComplete="username"
              className="w-full rounded-2xl border border-white/10 bg-white/8 px-4 py-3 text-white placeholder:text-slate-400 focus:border-teal-300 focus:outline-none"
            />
          </label>
          <label className="block space-y-2 text-sm font-medium text-slate-100">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full rounded-2xl border border-white/10 bg-white/8 px-4 py-3 text-white placeholder:text-slate-400 focus:border-teal-300 focus:outline-none"
            />
          </label>
          {error && (
            <p role="alert" className="rounded-2xl border border-rose-300/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-teal-500 px-5 py-3.5 font-semibold text-white transition hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Signing in..." : "Sign In"} <ArrowRight className="h-4 w-4" />
          </button>
        </form>
      </div>
    </main>
  );
}
