import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "./db.js";

export const SESSION_COOKIE_NAME = "busynotify_session";
// ponytail: non-httpOnly, UI-routing-only. The frontend middleware reads this
// to decide which page to send someone to; it is never trusted for access
// control. Every protected route below re-checks the real session cookie.
export const ROLE_COOKIE_NAME = "busynotify_role";

const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function createSession(userId) {
  const id = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(id, userId, expiresAt);
  return { id, expiresAt };
}

export function getSessionUser(sessionId) {
  if (!sessionId) return null;

  const row = db
    .prepare(
      `SELECT users.id, users.username, users.role, users.display_name, sessions.expires_at
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.id = ?`
    )
    .get(sessionId);

  if (!row) return null;

  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(sessionId);
    return null;
  }

  return { id: row.id, username: row.username, role: row.role, displayName: row.display_name };
}

export function destroySession(sessionId) {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function setSessionCookies(res, session, role) {
  const cookieOptions = {
    sameSite: process.env.FRONTEND_ORIGIN ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
    expires: new Date(session.expiresAt),
  };

  res.cookie(SESSION_COOKIE_NAME, session.id, { ...cookieOptions, httpOnly: true });
  res.cookie(ROLE_COOKIE_NAME, role, { ...cookieOptions, httpOnly: false });
}

export function clearSessionCookies(res) {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.clearCookie(ROLE_COOKIE_NAME);
}

export function requireAuth(req, res, next) {
  const user = getSessionUser(req.cookies?.[SESSION_COOKIE_NAME]);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Not authenticated." });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Not authorized for this action." });
    }
    next();
  };
}
