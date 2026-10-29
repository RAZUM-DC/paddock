import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { twoFactor } from "better-auth/plugins";
import { chooseHarnessId, isAdmin, isValidHarnessId, legacyHarnessId, parseList } from "./identity";

const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:3000";

// Одна SQLite на морду: пользователи и сессии (better-auth) + то, что знает только морда (метаданные ходов, см. lib/turn-meta.ts).
// Конфиги харнесса сюда не кладём — они в его томе, он их сам читает и они переезжают вместе с ним.
export const db = new Database(process.env.AUTH_DB ?? "/data/auth.db");

// User → harness, fixed on first use: password users keep the part of their email before "@" (harness-<name> from
// add-user.sh), see lib/identity.ts. Stored so that a later change of the rule never moves anybody to another harness.
db.exec(`CREATE TABLE IF NOT EXISTS harness_users (
  user_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
)`);

const options = {
  database: db,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: publicUrl,
  trustedOrigins: [publicUrl],
  // Регистрации нет: пользователей заводит scripts/create-user.ts на сервере.
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
  session: { expiresIn: 60 * 60 * 24 * 30 },
  rateLimit: { enabled: true, window: 60, max: 30 },
  // Снаружи морда стоит за Traefik (LAN) и edge-nginx (docker): IP клиента берём из X-Forwarded-For справа налево
  // до первого не нашего адреса. Без этого лимит попыток входа общий на всех — и перебор, и блокировка всех сразу.
  advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"], trustedProxies: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] } },
  // 2FA по TOTP (Authy, Google Authenticator, 1Password): включается в Настройки → Вход в морду.
  // Включается сразу после «Включить»: показали QR, пользователь добавил его в Authy — готово, без ввода кода в настройках.
  plugins: [twoFactor({ issuer: "Paddock", skipVerificationOnEnable: true })],
} satisfies BetterAuthOptions;

export const auth = betterAuth(options);

export async function ensureDb() {
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
}

// The rule for password users (scripts/create-user.ts checks the name with it before creating the login).
export const codexUserOf = legacyHarnessId;

type SessionUser = { id: string; email: string };

const storedHarness = db.prepare("SELECT harness_id FROM harness_users WHERE user_id = ?");
const storeHarness = db.prepare("INSERT OR IGNORE INTO harness_users (user_id, harness_id, created_at) VALUES (?, ?, ?)");

// The harness of a signed-in user: harness-<id>, secrets/tokens/<id>.token. Throws when there is none — callers answer 403.
export function harnessIdOf(user: SessionUser): string {
  const row = storedHarness.get(user.id) as { harness_id: string } | undefined;
  if (row) {
    // The id becomes a host name, a file name and a container name: never trust it blindly, even from our own db.
    if (!isValidHarnessId(row.harness_id)) throw new Error(`bad harness id for user ${user.id}`);
    return row.harness_id;
  }
  const { id } = chooseHarnessId({ email: user.email, hasCredential: true });
  // UNIQUE(harness_id): two logins can never share a harness; the loser of a race reads the winner's row.
  if (storeHarness.run(user.id, id, Date.now()).changes === 0 && !storedHarness.get(user.id)) throw new Error(`harness ${id} belongs to another user`);
  return (storedHarness.get(user.id) as { harness_id: string }).harness_id;
}

// Admins: ADMIN_USERS (harness ids or emails).
export function isAdminUser(user: SessionUser): boolean {
  let harnessId = "";
  try {
    harnessId = harnessIdOf(user);
  } catch {}
  return isAdmin({ harnessId, email: user.email, adminUsers: parseList(process.env.ADMIN_USERS), oidcAdmin: false });
}
