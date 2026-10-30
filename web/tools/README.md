# Paddock tools

Tools and skills that Paddock installs into a user's harness. They do not depend on the harness:
a tool is a command (every agent has a shell) plus a skill that tells the agent when to call it.

One folder per tool:

| file | what |
|---|---|
| `tool.json` | `id`, `name` and `description` (a string or `{ "en": …, "ru": … }`), `bin` (the command file), `skill` (skill name), `needs` (which key it requires, e.g. `neuraldeep`), `default` (`true`: installed on connect unless the user removed it; a `removed` marker file in the tool's folder remembers the removal) |
| `<bin>` | the command itself, no dependencies (node) |
| `SKILL.md` | the skill; `{{BIN}}` is replaced with the command's path inside the harness on install |

Install (Settings → Tools): command → `<harness home>/paddock/tools/<id>/<bin>`,
skill → `<harness home>/skills/<skill>/SKILL.md`, tool settings → `<harness home>/paddock/tools/<id>/settings.json`.
If the command or the skill in the registry changes, the tool shows **update available**.

Rules that keep tools working everywhere:

- Talk to the outside world only through the proxy (`HTTPS_PROXY`, default `http://egress:8080`): harnesses have no direct internet.
  The one exception is web itself (`PADDOCK_WEB_URL`, default `http://web:3000`, `/api/harness/*`), reached directly and
  authenticated with the harness's own token (`PADDOCK_WS_TOKEN_FILE`, default `/run/secrets/ws-token`).
- Read keys from the harness config or env yourself; never ask the model to pass a key, so it never lands in the transcript.
- Print `saved: <absolute path>` for every file you produce; Paddock turns images into thumbnails.
- Keep the skill short: when to call, the exact command, what to show the user, what to do on error.

| tool | what |
|---|---|
| [agents](agents/) | see the user's other open chats and message them (via the harness app-server) |
| [images](images/) | image generation and editing, NeuralDeep |
| [secrets](secrets/) | asks the user for an API key or password through a masked form in Paddock and writes it into a file in `/workspace`; on by default |
