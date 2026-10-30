---
name: paddock-secrets
description: Get an API key, password or token from the user without it appearing in the chat, with the paddock-secret shell command. Use whenever a project needs a secret (API key, password, access token, connection string) that you do not have — never ask the user to paste it into the chat.
---

# Secrets from the user

Never ask the user to type or paste a secret into the chat, and never put one in a command line: the chat and the
command log are kept. Ask through Paddock instead; the user fills a masked form and the value goes straight into a file:

```bash
node {{BIN}} request NAME --file <path> [--reason "why it is needed"] [--timeout 900]
node {{BIN}} list                     # requests still waiting for the user
```

- `NAME` is the variable name (`OPENAI_API_KEY`, `DATABASE_PASSWORD`): A-Z, 0-9 and `_`.
- `--file` is where it goes, inside `/workspace` (usually the project's `.env`). The line `NAME=value` is added or
  replaced; the file is created if missing and gets mode 600. Make sure the file is in `.gitignore`.
- `--reason` is shown to the user in the form: say in one line what the secret is for.
- Tell the user in your reply that a form is waiting for them in Paddock, then run the command. It waits (up to 15
  minutes) until they save or decline.
- On success it prints only `saved NAME to <file> (N chars)`. Do not `cat`, `grep`, `echo` or otherwise print the file
  or the value afterwards; let the program read it from the file (dotenv, `--env-file`, `source`).
- `declined`: the user chose not to give it; ask how they want to proceed. `expired`: nobody answered in time; tell
  the user and offer to ask again.
