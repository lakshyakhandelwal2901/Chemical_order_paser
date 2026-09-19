import "dotenv/config";
import { db } from "./db.js";
import { hashPassword } from "./auth.js";

// ponytail: demo credentials for local development only. Change these (or
// create real users through your own admin flow, not yet built) before this
// runs anywhere but your own machine. Run with: npm run seed
const DEMO_USERS = [
  { username: "rohit", password: "sales123", role: "SALESPERSON", display_name: "Rohit" },
  { username: "priya", password: "manage123", role: "MANAGEMENT", display_name: "Priya" },
  { username: "admin", password: "admin123", role: "ADMIN", display_name: "Admin" },
];

const insert = db.prepare(
  "INSERT INTO users (username, password_hash, role, display_name) VALUES (?, ?, ?, ?)"
);
const findExisting = db.prepare("SELECT id FROM users WHERE username = ?");

for (const user of DEMO_USERS) {
  if (findExisting.get(user.username)) {
    console.log(`Skipping "${user.username}" - already exists.`);
    continue;
  }
  insert.run(user.username, hashPassword(user.password), user.role, user.display_name);
  console.log(`Created ${user.role} user "${user.username}" / "${user.password}"`);
}
