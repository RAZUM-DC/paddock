// Commit identity (user.name / user.email) for the agent's git: a small file in the harness home that the system
// gitconfig of the harness image includes (codex/gitconfig → ~/.codex/paddock/gitconfig). The browser writes it
// through the harness fs API, like tools. Pure, unit-tested in test/git-identity.test.mjs.

export const GIT_IDENTITY_FILE = "/home/codex/.codex/paddock/gitconfig";

export type GitIdentity = { name: string; email: string };

const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@<>"\\]{1,64}@[^\s@<>"\\]{1,255}$/;

export function validateIdentity(id: GitIdentity): string | null {
  const name = id.name.trim();
  const email = id.email.trim();
  if (!name && !email) return null; // both empty = remove the identity
  if (!name || name.length > 200 || CONTROL.test(name)) return "name: one line, up to 200 characters";
  if (!EMAIL.test(email)) return "email: an address like name@example.com";
  return null;
}

// git config value: double-quoted, with \ and " escaped. Newlines never get here (validateIdentity).
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function identityConfig(id: GitIdentity): string {
  const err = validateIdentity(id);
  if (err) throw new Error(err);
  const name = id.name.trim();
  const email = id.email.trim();
  if (!name && !email) return "# no commit identity set in Paddock\n";
  return `# written by Paddock (Settings → Git); edits here are overwritten from there\n[user]\n\tname = ${quote(name)}\n\temail = ${quote(email)}\n`;
}

// Reads back what identityConfig wrote (and the plain unquoted form someone may type by hand).
export function parseIdentity(text: string | null | undefined): GitIdentity {
  const out: GitIdentity = { name: "", email: "" };
  let inUser = false;
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)\s*\]$/.exec(line);
    if (section) {
      inUser = section[1].toLowerCase() === "user";
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (!inUser || !kv) continue;
    const key = kv[1].toLowerCase();
    if (key !== "name" && key !== "email") continue;
    let v = kv[2];
    const q = /^"((?:[^"\\]|\\.)*)"\s*$/.exec(v);
    v = q ? q[1].replace(/\\(.)/g, "$1") : v.replace(/\s+[#;].*$/, "").trim();
    out[key] = v;
  }
  return out;
}
