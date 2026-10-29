// Заводит или обновляет пользователя морды: npm run create-user -- valera@hub.local 'пароль'
// Часть до @ — имя контейнера codex-<name> и файла токена.
import { auth, codexUserOf, ensureDb } from "../lib/auth";

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 12) {
  console.error("usage: create-user <name@hub.local> <password, 12+ chars>");
  process.exit(1);
}
codexUserOf(email);

await ensureDb();
const ctx = await auth.$context;
const hash = await ctx.password.hash(password);
const existing = await ctx.internalAdapter.findUserByEmail(email);
if (existing) {
  await ctx.internalAdapter.updatePassword(existing.user.id, hash);
  console.log(`password updated: ${email}`);
} else {
  const user = await ctx.internalAdapter.createUser({ email, name: email.split("@")[0], emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  console.log(`created: ${email}`);
}
