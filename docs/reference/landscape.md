---
node_type: reference
title: Landscape — agent cockpits and how Paddock differs
description: "Herdr, Orca, bb and the closest alternatives: what each is, where agents run, and what Paddock does differently (infra, stable egress, isolation, web-only access)."
service: _platform
status: active
updated: 2026-10-29
---

# Landscape — agent cockpits and how Paddock differs

Every product below drives existing coding agents (Claude Code, Codex, OpenCode, Pi and others) rather than shipping its own. They split into three groups. **Local cockpits** run on your machine: herdr, Claude Squad and cmux in the terminal; Orca, bb, Conductor and Happy as desktop apps. **Self-hosted servers** run on your own box with a browser client: bb in server mode, OpenHands Agent Canvas, Coder, Vibe Kanban. **Vendor clouds** run agents in the vendor's VMs: Claude Code on the web and Codex cloud. Most local cockpits now also offer a remote mode (SSH, Tailscale, or a vendor relay) and a phone companion. So "web and phone" alone no longer sets Paddock apart. What does: Paddock ships the infrastructure (one `docker compose` on a VPS), seals each user in their own container with a mandatory egress proxy chain with failover, and puts a password plus TOTP login on a public URL. No other product here documents all of that together. In return Paddock has one harness today (Codex), against 15 to 30+ in Orca, herdr and bb, and no worktree or orchestration layer.

Facts below were checked on 2026-10-29 against the sources listed. "Not documented" means I found nothing in the primary sources. It does not mean the feature is missing.

## Comparison

| Product | Form factor | Where agents run | Harnesses | Multi-user | Isolation | Egress / proxy | Auth | Mobile | License |
|---|---|---|---|---|---|---|---|---|---|
| **Paddock** | self-hosted web server (`docker compose`) | your VPS, one container per user | Codex app-server (OpenCode, Hermes, PicoClaw, pi, omp planned) | yes, a harness container per user | container per user, `cap_drop: ALL`, internal network, LAN/host closed | built-in gost proxy chain with failover, health per proxy × API | password + TOTP 2FA, backup codes | any browser | MIT |
| **herdr** | terminal multiplexer (Rust binary) | your machine or SSH hosts | any terminal agent, 15+ auto-detected | not documented | none (owns PTYs, no sandbox) | not documented | OpenSSH for remote | not documented | Apache-2.0 (AGPL until 2026-07-22) |
| **Orca** | desktop app (Electron) + mobile companion | laptop, SSH hosts, a Remote Orca Server, or cloud VMs | any CLI agent, 30+ listed | several paired clients per server, no user accounts documented | git worktree per agent; cloud VMs "isolated and disposable" | not documented (Tailscale suggested) | per-client revocable pairing token | iOS + Android companion | MIT |
| **bb** (get-bb/bb) | desktop app + web app + CLI + HTTP API (Node server) | the bb server host plus enrolled "execution machines" | Claude Code, Codex, Cursor, Pi, OpenCode, Grok, Hermes, any ACP agent | not documented (one account owner) | git worktrees; no container sandbox documented | not documented | bb connect (account-gated) or Tailscale; raw API is unauthenticated | mobile app (bb connect) and phone browser | MIT |
| **Conductor** | macOS desktop app (+ Conductor Cloud) | your Mac; cloud workspaces in Conductor Cloud | Claude Code, Codex | not verified | git worktree per workspace | not documented | not verified | not verified | proprietary, free app (secondary source) |
| **Claude Squad** | terminal app (tmux) | your machine | Claude Code, Codex, Gemini, Aider, any CLI | no | git worktree per task | not documented | — | no | AGPL-3.0 |
| **Vibe Kanban** | local web app (`npx`) + self-hostable cloud | your machine | Claude Code, Codex, Gemini, Copilot, Amp, Cursor, OpenCode and others | team kanban in the cloud version | workspace = branch + terminal + dev server | not documented | not verified | not documented | Apache-2.0, **sunsetting** |
| **OpenHands Agent Canvas** | self-hosted web control center | local, Docker, VMs, OpenHands Cloud | OpenHands, Claude Code, Codex, Gemini, Pi, OpenCode, any ACP agent | shared agent server for a team | Docker sandbox optional; "without a sandbox" mode has full FS access | not documented | see SELF_HOSTING.md (not verified) | not documented | MIT |
| **Coder** | self-hosted CDE platform | your infra: VMs, K8s pods, Docker (Terraform) | Coder Agents (native) + any agent in a workspace | yes, built for teams | workspace per user via Terraform, WireGuard tunnel | AI Gateway centralizes model access; proxy failover not documented | user accounts, SSO in Premium (not verified) | browser | AGPL-3.0 + Premium |
| **Happy** | mobile/web app + desktop app + CLI + relay | your machine | Claude, Codex, Grok, Gemini (Antigravity), OpenCode, ACP agents | "natively multiplayer" shared sessions | not documented | not documented | E2E-encrypted relay | iOS, Android, web | MIT |
| **cmux** | macOS terminal (Ghostty-based) | your Mac | any terminal agent | no | none | not documented | — | not documented | GPL-3.0+ (server parts BSL 1.1) |
| **Claude Code on the web** | vendor cloud SaaS | Anthropic-managed VM (or your self-hosted environment) | Claude Code only | Team/Enterprise sharing | isolated VM per session; credentials kept outside | allowlist proxy, network limited by default | claude.ai account | Claude mobile app | proprietary; Pro/Max/Team/Enterprise plans |
| **Codex cloud** | vendor cloud SaaS | OpenAI cloud container (`universal` image) | Codex only | Business/Enterprise share environments | container per task | agent internet off by default; all traffic via an HTTP/HTTPS proxy | ChatGPT account | ChatGPT web/mobile/desktop | proprietary; ChatGPT plans |

## herdr

- A terminal multiplexer for coding agents: "the runtime your coding agents live on". Workspaces, tabs and split panes as in tmux, with agent state marked per pane (working, blocked or idle) and detected automatically.
- A single Rust binary ("no electron") that runs in your existing terminal. The background server keeps panes alive when the client detaches or SSH drops. After a reboot the layout comes back, but the original processes do not.
- Remote work: `herdr --remote host` over plain OpenSSH. The remote server owns the panes and the local client draws the UI. Agents from several saved machines show up in one combined list.
- Agents drive herdr through a CLI and socket API: they can spawn panes, prompt each other, and wait until another agent is blocked. It also has a plugin marketplace.
- License: Apache-2.0 since commit `cd5ea1b` (2026-07-22, "relicense herdr under apache-2.0"). Before that it was AGPL with commercial dual licensing, which is probably why it got described as AGPL. About 46k stars.
- No web or mobile client, multi-user mode or sandbox is documented.
- Sources: [github.com/herdrdev/herdr](https://github.com/herdrdev/herdr), [herdr.dev/docs/persistence-remote](https://herdr.dev/docs/persistence-remote/), [relicense commit](https://github.com/herdrdev/herdr/commit/cd5ea1be0e69ed49b6f32f7ed5b333f6c8526874)

## Orca

- "The AI Orchestrator for 100x builders": a desktop app (macOS, Windows, Linux) for running many CLI agents side by side, each in its own git worktree. MIT, about 109k stars, by Stably AI.
- Features: parallel worktrees (one prompt fanned out to N agents, then compare and merge), WebGL terminal splits, Design Mode (click an element in an embedded Chromium window to send its HTML, CSS and a screenshot to the agent), GitHub/Linear/Jira drawers, annotations on AI diffs, account hot-swap and usage tracking, scheduled automations, worktree checkpoints, computer use.
- Four ways to run: local, SSH worktrees (agents run remotely, UI stays local), a Remote Orca Server (`orca serve` or the desktop app; laptops, browsers and phones attach as clients; beta), and cloud VMs per worktree from an `orca.yaml` recipe on your own cloud account.
- Auth on a remote server: revocable pairing tokens per client. The docs advise against exposing the port to the internet and recommend Tailscale. No user accounts, roles or 2FA are documented.
- Mobile companion apps for iOS and Android, paired through a relay (`cloud/` in the repo). The app collects anonymous telemetry, with an opt-out.
- **Unverified:** "Runs / Tasks / Dispatches, decision gates, DAG". The docs have an Orchestration page (`/docs/cli/orchestration`), but I could not read it, so these terms are not confirmed.
- Sources: [github.com/stablyai/orca](https://github.com/stablyai/orca), [onorca.dev/docs/ways-to-run](https://www.onorca.dev/docs/ways-to-run), [onorca.dev/docs/remote-servers](https://www.onorca.dev/docs/remote-servers), [docs index](https://www.onorca.dev/docs)

## bb

- Most likely candidate: **bb by get-bb**, "the agent IDE that builds itself" (MIT, about 4.7k stars, npm `bb-app`). It fits the owner's "bb is a desktop app" (the recommended install is the desktop app), and its harness list (Pi, omp, Hermes, ACP) almost matches Paddock's roadmap. I found no other AI-coding product commonly called "bb".
- Architecturally it is the closest product to Paddock. Under the desktop shell sits a **Node server + web app** (`npx bb-app` serves `http://localhost:38886`), and the web app, CLI, HTTP API and SDK are all first-class surfaces. So the answer to "is it built like bb?" is partly yes: both are a server with a browser UI.
- The differences: bb runs on your own machine with your own CLI logins. Remote access goes through "bb connect" (a getbb.app tunnel tied to your account) or Tailscale Serve. Binding to `0.0.0.0` exposes an API that is "unauthenticated and permits command execution and file reads". One server can dispatch threads to several enrolled "execution machines".
- Threads can be watched live, steered, and handed off between agents. Manager threads coordinate child threads, and git worktrees separate work. No container sandbox or egress proxy is documented. Anonymous telemetry is on by default.
- Desktop: macOS arm64 stable; Linux and Windows are alpha.
- Sources: [github.com/get-bb/bb](https://github.com/get-bb/bb), [packages/bb-app README](https://github.com/get-bb/bb/blob/main/packages/bb-app/README.md), [docs/multiple-devices.md](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md), [getbb.app](https://getbb.app/claude-code-and-codex)

## Conductor

- A Mac desktop app by Melty Labs for running parallel Claude Code and Codex agents. Each workspace is a git worktree with its own branch, terminal, diff and checks. From there you review, comment back to the agent, open a PR and merge.
- Conductor Cloud runs workspaces in the cloud when the laptop is the bottleneck.
- **Partly unverified:** conductor.build returned 403 to fetches. The facts above come from search snippets of conductor.build pages. "Free, Apple Silicon only" comes from a third-party write-up. Licensing, team features and mobile access are not verified.
- Sources: [conductor.build/workflows/run-parallel-claude-codes](https://www.conductor.build/workflows/run-parallel-claude-codes), [conductor.build/compare/claude-code](https://conductor.build/compare/claude-code), [morphllm.com write-up](https://www.morphllm.com/conductor-ai-coding)

## Claude Squad

- A terminal app (`cs`, Go, tmux plus gh) that manages several Claude Code, Codex, Gemini or Aider instances, each in its own git worktree. Tasks run in the background, and there is an experimental auto-accept mode.
- Purely local and single-user. AGPL-3.0, about 8.7k stars.
- Source: [github.com/smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)

## Vibe Kanban

- A kanban board plus agent workspaces (each with a branch, terminal and dev server), inline diff comments, a built-in preview browser, and 10+ agents. Started with `npx vibe-kanban`. It also has a self-hostable cloud for teams (Docker).
- The README now says **"Vibe Kanban is sunsetting"**. Apache-2.0, about 28k stars.
- Sources: [github.com/BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban), [shutdown post](https://www.vibekanban.com/blog/shutdown)

## OpenHands Agent Canvas

- "The self-hosted developer control center for coding agents and automations": a web front end that switches between agent backends (local, Docker, VMs, OpenHands Cloud or Enterprise). It runs OpenHands, Claude Code, Codex, Gemini, Pi, OpenCode and any ACP agent.
- Strong on automations: scheduled and webhook triggers with Slack, GitHub, Linear and Notion integrations. A team can share one agent server.
- The default install has no sandbox and gives the agent "full access to your filesystem". Docker backends are optional. Hardening is described in SELF_HOSTING.md, which I did not read. MIT, about 92k stars.
- Sources: [github.com/OpenHands/OpenHands](https://github.com/OpenHands/OpenHands), [backends docs](https://docs.openhands.dev/openhands/usage/agent-canvas/backends)

## Coder

- A self-hosted platform for cloud development environments: workspaces defined in Terraform (VMs, Kubernetes pods, Docker), connected through a WireGuard tunnel, and shut down automatically when idle.
- Coder Agents runs a native agent loop in the control plane, so no LLM keys live in workspaces. Every action carries a user identity, and model access is centrally governed, cost-tracked and audited. An AI Gateway centralizes auth and auditing.
- This is the enterprise-grade answer to "multi-user, isolated, on your infrastructure", but it is heavier: Postgres and Terraform templates. AGPL-3.0, with paid Premium.
- Sources: [github.com/coder/coder](https://github.com/coder/coder), [coder.com/docs/ai-coder/agents](https://coder.com/docs/ai-coder/agents)

## Happy

- "Happy Harness": a mobile, web and desktop app plus a CLI that drives Claude, Codex, Grok, Gemini (through Antigravity), OpenCode and ACP agents on your own hardware, with the subscriptions you already pay for.
- Sessions sync to the phone through an end-to-end encrypted relay (`happy-server`, in the repo). Sessions are "natively multiplayer": a colleague can watch and steer the same agent.
- MIT, about 24k stars.
- Source: [github.com/slopus/happy](https://github.com/slopus/happy)

## cmux

- A Ghostty-based macOS terminal with vertical tabs, notification rings when an agent needs attention, a notification panel, and a scriptable in-app browser.
- GPL-3.0-or-later. The server parts (web, Cloudflare workers, relay) are under BSL 1.1, and production self-hosting of those needs a commercial license. About 28k stars.
- Source: [github.com/manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)

## Claude Code on the web (cloud sessions)

- Claude Code sessions run in isolated VMs managed by Anthropic, or in an organization's self-hosted environment. They can be started from claude.ai/code, the Claude mobile app, the desktop app or `claude --cloud`, and pulled back to a terminal with `--teleport`.
- Network access is limited by default and can be disabled. GitHub credentials and network secrets stay outside the VM, and a proxy attaches them. Auto-fix can watch a PR for CI failures and review comments.
- Requires a claude.ai account on Pro, Max, Team or Enterprise, and GitHub for cloning and PRs. Claude Code is the only harness. Not available through Bedrock or Vertex.
- Source: [code.claude.com/docs/en/claude-code-on-the-web](https://code.claude.com/docs/en/claude-code-on-the-web)

## Codex cloud

- Codex tasks run in an OpenAI cloud container (the `universal` image) with a setup script. Agent internet access is off by default (limited or unrestricted are options), and all outbound traffic goes through an HTTP/HTTPS proxy. Secrets are visible to setup scripts only.
- Available on web, mobile and desktop through ChatGPT. On Business and Enterprise, container caches are shared across an environment's users. Codex is the only harness.
- Source: [learn.chatgpt.com — cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment.md), [developers.openai.com/codex/cloud/environments](https://developers.openai.com/codex/cloud/environments)

## Where Paddock is different

What Paddock does that no product above documents as a whole:

1. **The infrastructure is the deliverable.** One `docker compose` on any VPS gives you a public HTTPS cockpit. Orca, bb and herdr assume your own machine, plus Tailscale or SSH if you want reach. Coder and OpenHands do offer self-hosting but need Terraform/Postgres or backend setup of their own, and the vendor clouds are not self-hosted at all.
2. **Stable egress is a product feature.** Every agent's traffic goes through a gost proxy chain with failover, and the UI shows health per proxy × API. None of the products above documents proxy failover for reaching AI APIs. The vendor clouds do proxy egress, but to enforce an allowlist, not to get out of a blocked region. This is the decisive point for Russia, where Paddock is meant to run.
3. **Isolation by default, per user.** A container per user with `cap_drop: ALL`, an internal network, and LAN and host closed; the browser never sees the harness token. Orca, bb, Conductor and Claude Squad isolate only with git worktrees. OpenHands' default install has no sandbox. bb's raw API is unauthenticated. Only Coder and the vendor clouds are comparable here.
4. **Public-internet login built in:** password + TOTP 2FA, backup codes, trusted browsers, per-IP rate limit. Orca and bb rely on pairing tokens or tunnels and warn against exposing the port.
5. **Multi-user on one instance**, each user with their own harness, volumes and quotas. Among self-hosted products only Coder (and partly OpenHands and Happy's shared sessions) go here.
6. **Plain-browser access, phone included, with no app and no laptop that has to stay awake.** Orca, bb and Happy reach the phone through companion apps and relays, but the agents still run on a machine you keep on.

Where others are clearly ahead:

- **Harness breadth.** Paddock has only Codex today. Orca lists 30+ CLI agents, herdr auto-detects 15+, and bb, OpenHands and Happy speak ACP. An ACP adapter would cover Hermes, Cursor and many others in one go.
- **Parallel work and review:** worktree per agent, fanning one prompt out to N agents, diff annotation sent back to the agent, PR create/merge (Orca, Conductor, bb, Vibe Kanban, Claude Squad).
- **Orchestration:** agents spawning and prompting each other through a socket API or CLI (herdr, Orca CLI, bb manager threads), scheduled and webhook automations (OpenHands, Orca), PR auto-fix (Claude Code on the web).
- **Terminal fidelity:** real PTYs, attach and detach, any TUI agent unchanged (herdr, cmux, Orca). Paddock renders a structured protocol, so a TUI-only harness needs an adapter.
- **Native mobile apps and push notifications** (Orca, Happy, Claude, ChatGPT).
- **Enterprise governance:** audit, cost tracking, SSO, Terraform templates (Coder).
- **Maturity and community.** Most alternatives have 5k to 100k+ stars. Paddock went public on 2026-10-29.

What Paddock could borrow:

- From herdr: pane statuses (working, blocked, idle) as a cross-harness contract, and a socket/CLI API so agents can open chats and message each other (already on the roadmap).
- From Orca, Conductor and bb: worktree per chat, "fan out the same prompt to N panes and compare", diff annotations sent back as a message, and decision gates and queues.
- From bb, OpenHands and Happy: an **ACP adapter** as the generic harness path, ahead of one adapter per harness.
- From Claude Code on the web: network secrets attached by the proxy so keys never enter the container (Paddock's egress layer is the natural place), and PR auto-fix.
- From Orca, Happy and bb: push notifications (Web Push / PWA) when a pane needs approval or finishes.

## Could not verify

- Orca's "Runs / Tasks / Dispatches, decision gates, DAG": I could not read the orchestration docs page.
- Conductor's license, pricing, team and mobile features: conductor.build and its docs returned 403.
- Auth details for Vibe Kanban cloud, OpenHands self-hosting and Coder SSO: I did not read those docs.
- Whether any vendor cloud works from Russia: not checked against the vendors' supported-country lists.
