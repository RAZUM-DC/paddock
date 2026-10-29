# tests

End-to-end tests with puppeteer-core against a running instance (needs Chrome; `CHROME=` sets the path, macOS default otherwise).

| file | what | run |
|---|---|---|
| `ui-tour.mjs` | 18 steps across the whole UI: login, answer, edit, model picker, tool cards, limits, folders, every settings tab, files panel, layouts; screenshots; archives its test chats | `HUB_PASS=… node tests/ui-tour.mjs /tmp/tour` |
| `grid-edges.mjs` | pane grid edge cases: splitter clamps 20/80, double-click, drag while answering, drop outside, 4→1→4, Alt+N, reload, close, 1280×720; bottom-right pane keeps a pasted message in view | `HUB_PASS=… node tests/grid-edges.mjs` |
| `images-and-screens.mjs` | Tools tab enables image generation, the agent draws a picture, thumbnail and lightbox, session tools popover, tokens/s; spends one NeuralDeep generation | `HUB_PASS=… node tests/images-and-screens.mjs /tmp/shots` |
| `two-factor.mjs` | 2FA: enable with QR (TOTP computed from the secret like Authy), login asks for a code, wrong code rejected, right code lets in; disables it back | `HUB_PASS=… node tests/two-factor.mjs` |
| `readme-screens.mjs` | README screenshots from existing chats, no new generations | `HUB_PASS=… node tests/readme-screens.mjs docs/img` |

`HUB_URL` (default `http://localhost:8088`; behind a domain the UI only accepts its own `PUBLIC_URL` origin), `HUB_EMAIL` (default `valera@hub.local`).
