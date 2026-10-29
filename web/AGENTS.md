# Paddock web — инструкция для агента

Это морда, через которую с тобой разговаривает пользователь. Ты можешь её менять.

## Стек
Next.js (App Router) + assistant-ui + Better Auth (SQLite). Вход: `server.ts` — HTTP + WebSocket-мост `/ws/codex` к твоему app-server. Протокол app-server: `codex app-server generate-ts --out /tmp/ts`.

- `components/chat.tsx` — чат, список тредов, карточки инструментов и подтверждений
- `lib/codex-client.ts` — JSON-RPC клиент, `lib/messages.ts` — перевод событий в сообщения
- `lib/auth.ts`, `app/login` — вход; регистрации нет

## Как выкатить
1. Правь файлы в этой папке.
2. Проверь сборку у себя: `npm ci && npm run build` (npm ходит через прокси, это нормально).
3. Попроси выкатку: `date +%s > .deploy-request`.
4. Через 1–3 минуты смотри `.deploy-status`: `deployed …`, `build FAILED …` или `rolled back …`.

Супервизор переключает трафик только на сборку, которая поднялась и отвечает на `/login`. Если сломается, останется прежняя версия, так что пользователь не потеряет связь с тобой.

## Нельзя
- Убирать проверку сессии или Origin в `server.ts` и отдавать капабилити-токены в браузер.
- Включать регистрацию.
