// Secrets at rest in the auth db (git tokens): AES-256-GCM with a key that never leaves web's environment.
// Key: PADDOCK_SECRETS_KEY (64 hex characters) if set, else HKDF-SHA256 from BETTER_AUTH_SECRET (info "paddock-secrets-v1").
// Each ciphertext is bound to its row through the additional data (aad), so it cannot be moved to another user or row.
// Pure node:crypto, so it runs under `node --test` (see test/secrets.test.mjs).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const SECRETS_INFO = "paddock-secrets-v1";
const VERSION = "v1.";
const IV = 12;
const TAG = 16;

export function secretsKeyFrom(env: Record<string, string | undefined>): Buffer {
  const hex = env.PADDOCK_SECRETS_KEY?.trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PADDOCK_SECRETS_KEY must be 64 hex characters (openssl rand -hex 32)");
    return Buffer.from(hex, "hex");
  }
  const base = env.BETTER_AUTH_SECRET ?? "";
  if (base.length < 16) throw new Error("set PADDOCK_SECRETS_KEY or BETTER_AUTH_SECRET (16+ characters) to store secrets");
  return Buffer.from(hkdfSync("sha256", base, Buffer.alloc(0), SECRETS_INFO, 32));
}

const checkKey = (key: Buffer) => {
  if (key.length !== 32) throw new Error("secrets key must be 32 bytes");
};

// "v1." + base64url(iv | tag | ciphertext)
export function seal(key: Buffer, plaintext: string, aad: string): string {
  checkKey(key);
  const iv = randomBytes(IV);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return VERSION + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

// Throws on a wrong key, a wrong aad or any change to the ciphertext.
export function open(key: Buffer, sealed: string, aad: string): string {
  checkKey(key);
  if (!sealed.startsWith(VERSION)) throw new Error("unknown secret format");
  const buf = Buffer.from(sealed.slice(VERSION.length), "base64url");
  if (buf.length < IV + TAG) throw new Error("secret too short");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, IV));
  d.setAuthTag(buf.subarray(IV, IV + TAG));
  d.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([d.update(buf.subarray(IV + TAG)), d.final()]).toString("utf8");
}
