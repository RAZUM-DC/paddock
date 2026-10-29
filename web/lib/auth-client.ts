// Клиент better-auth для браузера: вход, смена пароля, 2FA.
import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({ plugins: [twoFactorClient()] });
