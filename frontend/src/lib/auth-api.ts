export type SessionUser = {
  id: number;
  username: string;
  role: "SALESPERSON" | "MANAGEMENT" | "ADMIN";
  displayName: string | null;
};

const parserBaseUrl = process.env.NEXT_PUBLIC_PARSER_API_BASE_URL ?? "http://127.0.0.1:3001/api";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function login(username: string, password: string): Promise<{ user: SessionUser }> {
  const response = await fetch(`${parserBaseUrl}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return parseJson(response);
}

export async function logout(): Promise<void> {
  await fetch(`${parserBaseUrl}/auth/logout`, { method: "POST", credentials: "include" });
}

export async function getCurrentUser(): Promise<{ user: SessionUser } | null> {
  const response = await fetch(`${parserBaseUrl}/auth/me`, { credentials: "include" });
  if (response.status === 401) return null;
  return parseJson(response);
}

export function dashboardPathForRole(role: SessionUser["role"]) {
  return role === "SALESPERSON" ? "/sales" : "/management";
}
