import { Router } from "express";
import { db } from "./db.js";
import {
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookies,
  clearSessionCookies,
  requireAuth,
  SESSION_COOKIE_NAME,
} from "./auth.js";

const router = Router();

router.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const session = createSession(user.id);
  setSessionCookies(res, session, user.role);
  res.json({
    user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
  });
});

router.post("/logout", (req, res) => {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  if (sessionId) destroySession(sessionId);
  clearSessionCookies(res);
  res.json({ success: true });
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
