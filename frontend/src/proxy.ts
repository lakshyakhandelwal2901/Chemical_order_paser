import { NextResponse, type NextRequest } from "next/server";

// Keep in sync with ROLE_COOKIE_NAME in the backend's auth.js.
const ROLE_COOKIE = "busynotify_role";

// ponytail: this cookie is only ever used to pick which page to show. It is
// not httpOnly and is never trusted for access control - every protected
// backend route re-checks the real session cookie via requireAuth/requireRole
// in auth.js regardless of what this proxy decided.
function dashboardFor(role: string | undefined) {
  return role === "SALESPERSON" ? "/sales" : "/management";
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const role = request.cookies.get(ROLE_COOKIE)?.value;

  if (pathname === "/") {
    return NextResponse.redirect(new URL(role ? dashboardFor(role) : "/login", request.url));
  }

  if (pathname === "/login" && role) {
    return NextResponse.redirect(new URL(dashboardFor(role), request.url));
  }

  if (pathname.startsWith("/sales")) {
    if (!role) return NextResponse.redirect(new URL("/login", request.url));
    if (role !== "SALESPERSON" && role !== "ADMIN") {
      return NextResponse.redirect(new URL(dashboardFor(role), request.url));
    }
  }

  if (pathname.startsWith("/management")) {
    if (!role) return NextResponse.redirect(new URL("/login", request.url));
    if (role !== "MANAGEMENT" && role !== "ADMIN") {
      return NextResponse.redirect(new URL(dashboardFor(role), request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/login", "/sales/:path*", "/management/:path*"],
};
