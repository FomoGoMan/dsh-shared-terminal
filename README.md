# dsh-shared-terminal

[English](README.md) | [中文](README.zh.md)

A DeepSeek Harness (DSH) bundle that turns the **Web sidebar terminals into shared human + agent terminals**: you open a terminal in the right sidebar and type whatever must stay in your hands (SSH passwords, one-time codes); the agent then lists, types into, and reads **the same session** with its tools — you watch every keystroke live in your tab.

No tmux bridge, no secrets through the model, no new UI, no new PTYs.

## Why

DSH ships two terminal systems that cannot see each other:

| | Person (sidebar) | Agent (`terminal_open`) |
|---|---|---|
| Service | `api-terminal-controller` (`terminalController`) | `dsh-terminal` (`ctx.terminals`) |
| Isolation | per Session | per Agent object identity |
| UI | xterm.js tabs | none |

This bundle bridges the agent tools onto the terminals the controller owns — the person's tabs stay the single display, and interactive authentication stays a human-only step.

## Tools

| Tool | What it does |
|---|---|
| `shared_terminal_list` | List this Session's sidebar terminals (id, title, shell, directory, size, state) |
| `shared_terminal_send` | Type into a terminal (Enter by default; `submit: false` for partial input such as a username before a password prompt); optionally waits for the shell to look idle and returns the screen |
| `shared_terminal_read` | Read a terminal's current screen — exactly what the person sees; never takes input control |
| `shared_terminal_rename` | Name a terminal (1–120 chars); the sidebar tab title updates live |

**Referencing by name**: every tool's `id` accepts the terminal id **or its exact title**. Rename by double-clicking the tab title in the sidebar, or ask the agent to call `shared_terminal_rename`; then just say "operate the jump-host terminal". Ambiguous titles are refused with the candidate ids listed.

## Install

Works on any machine already running a DSH Web profile. Node 20+ (or whatever your `dsh` runtime uses), pnpm, and `dsh` on PATH.

### Hand this to your agent

> Install https://github.com/FomoGoMan/dsh-shared-terminal into my `<profile>` profile: clone it, build it, install it as a link dependency, verify the bundle registered, then tell me to restart dsh.

The agent should run:

```bash
git clone https://github.com/FomoGoMan/dsh-shared-terminal.git
cd dsh-shared-terminal
pnpm install
pnpm build
dsh plugin --profile <your-profile> add link:"$PWD"
dsh --profile <your-profile> --dump-config | grep shared-terminal   # composition check
```

Then **restart dsh** (the harness loads bundles at boot; a restart also closes any open sidebar terminal processes):

```bash
kill $(lsof -ti :3082)   # stop the web instance (adjust if you run another port/app)
dsh --profile <your-profile> --no-open   # start it the way you normally do
```

### Manual install

Same commands as above, run by hand. `<your-profile>` is the profile your Web UI runs under — check the running instance with `lsof -nP -iTCP:<port> -sTCP:LISTEN` and inspect the process's open files, or just use the profile you boot `dsh web` with.

### Verify

1. `dsh --profile <your-profile> --dump-config | grep shared-terminal` — the composed tree contains `- id: shared-terminal`.
2. After restart, ask your agent to "list shared terminals" — it should call `shared_terminal_list` and return your sidebar terminals.
3. Open a sidebar terminal, then have the agent type `echo hello from the agent` into it — you see it appear live.

### Troubleshooting

- **`shared-terminal: the terminalController service is required`** — your profile lacks the Web app's terminal controller. Add `@deepseek-ai/dsh-web-app` to the profile's bundles (any Web profile has it by default).
- **Version-compatibility rejection on install** — the bundle targets dsh `0.2.1-rc.3` (see `peerDependencies`). Match your dsh runtime (`dsh --version`): clone the tag matching your version, or grant the exemption dsh prints (at your own risk).
- **Tools missing after restart** — confirm the bundle is in the profile's `package.json` under `dsh.profile.bundles` and that `lib/index.js` exists (run `pnpm build` inside the clone).

## Usage — the jump-host workflow

1. **You**: sidebar → **New Terminal** → `ssh jump` → type the password/OTP yourself.
2. **You**: tell the agent: "take over my sidebar terminal" (optionally: "name it jump-host first").
3. **Agent**: `shared_terminal_list` → `shared_terminal_read` to see where you are → `shared_terminal_send` to run commands → `shared_terminal_read` for results.
4. Everything the agent types appears live in your tab; your credentials never enter the conversation.

## Design notes

- **Writes** go through the terminal's process handle `write()` inside the controller's own operation queue — the exact path every sidebar attach uplink write takes — so input and screen state stay serialized with the person's own typing, and the retention idle clock is reset the same way (the unattended reaper will not close a terminal the agent is actively driving).
- **Reads** render the controller's internal headless screen model — the same data the UI shows — deliberately *not* via `attach`, which holds exclusive input control and would yank the person's typing session.
- **Scoping**: the controller only exposes this Session's terminals; closed/failed terminals error clearly; the input byte cap follows the controller configuration (64 KiB by default).

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxResultBytes` | 262144 | UTF-8 cap for one complete tool result |
| `sendWaitMs` | 3000 | Default post-submit idle-wait window (0–20000 ms; per-call `waitMs` overrides) |

## Limitations

- Terminal processes remain controller assets: closing the sidebar tab ends the process; the unattended reaper closes idle unattached terminals after `unattendedTimeoutMs` (2 h default).
- Agent typing and human typing share one PTY — simultaneous keystrokes interleave, like two people on one keyboard. That is the point.
- No close/signal tools: close tabs in the UI, or have the agent send `\x03` (Ctrl-C) as text.
- Idle detection reads shell activity markers; custom prompts (e.g. a themed zsh) may report `unknown`, in which case the send's wait window simply elapses and the screen is returned as-is.

## Development

```bash
pnpm install
pnpm build
node --experimental-strip-types tests/smoke.ts   # contract + behaviour smoke test
```

Built for dsh `0.2.1-rc.3`; host services resolve from the running harness at runtime (`neverBundle: /^@deepseek-ai\//`).

## License

MIT
