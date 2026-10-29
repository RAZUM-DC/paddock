import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { twoFactor } from "better-auth/plugins";

const publicUrl = process.env.PUBLIC_URL ?? "http://localhost:3000";

// Одна SQLite на морду: пользователи и сессии (better-auth) + то, что знает только морда (метаданные ходов, см. lib/turn-meta.ts).
// Конфиги харнесса сюда не кладём — они в его томе, он их сам читает и они переезжают вместе с ним.
export const db = new Database(process.env.AUTH_DB ?? "/data/auth.db");

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
  plugins: [twoFactor({ issuer: "Paddock" })],
} satisfies BetterAuthOptions;

export const auth = betterAuth(options);

export async function ensureDb() {
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
}

// Пользователь «valera@hub.local» работает со своим контейнером codex-valera.
export function codexUserOf(email: string): string {
  const name = email.split("@")[0];
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad codex user: ${name}`);
  return name;
}
