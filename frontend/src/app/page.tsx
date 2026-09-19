import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// ponytail: middleware.ts already redirects "/" before this renders in the
// normal case; this is just the server-side fallback if middleware is ever
// bypassed (e.g. a static export or a config change).
export default async function Home() {
  const cookieStore = await cookies();
  const role = cookieStore.get("busynotify_role")?.value;
  redirect(role === "SALESPERSON" ? "/sales" : role ? "/management" : "/login");
}