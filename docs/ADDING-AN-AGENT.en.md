# Adding a new Agent

[中文](ADDING-AN-AGENT.md)

This guide walks contributors through making Antumi support a new Agent (a coding CLI), step by step. Adding an Agent means changing Antumi's source code. Task sources are different: they are plugins and need no source changes, see [Task source plugins](PLUGINS.md).

Before you start, open an issue on GitHub (Settings → External agents → Open an issue prefills the template). Say which Agent you want and how its CLI can be driven by a program, so nobody duplicates the work and the approach can be agreed first. The full reference for every registry is in [Architecture → 新增 Agent](ARCHITECTURE.md#新增-agent) (Chinese).

## Before you start

**Check that the CLI can be driven by a program.** Antumi does not script a terminal; it talks to an Agent over a structured protocol. Three common cases:

| What the CLI offers | Examples | Can it be added? |
|---|---|---|
| ACP (Agent Client Protocol, e.g. `xxx acp`, `xxx --acp`) | Cursor, OpenCode, Kimi Code, Gemini CLI, CodeBuddy | Easiest: write one dialect |
| Its own JSON-RPC or streaming protocol (e.g. `app-server`, `--mode rpc`) | Codex, Pi, ZCode | Yes: write a driver of its own |
| Only an interactive terminal UI | — | No |

**Find out the following**; every later step uses it:

- The start command and its arguments; any environment variables it needs.
- Its permission or approval modes (ask, accept edits, plan, bypass…).
- Sessions: can they be resumed, are they bound to the folder they started in, can one be forked from a turn.
- How to sign in and how to tell it is signed in; how to list models.
- What approvals, questions and plan reviews look like on the wire.

**Set up a development environment.** You need Node ≥ 22.13 and pnpm 12.

```bash
pnpm install
ANTUMI_HOME=~/.antumi-dev pnpm dev   # a separate instance that leaves ~/.antumi alone
```

Point `ANTUMI_HOME` at any empty folder; the daemon, core and desktop app keep their own database and worktrees there.

## Step 1: protocol, describe what it is

The descriptor is plain data shared by core, the desktop app and the phone app.

1. Add the id at the end of `AGENT_KINDS` in `packages/protocol/src/agent.ts`. Use a short lowercase name and never change it: it is written into the database and logs.
2. Create `packages/protocol/src/agents/<id>.ts` exporting an `AgentDescriptor`. Copying `kimi.ts` is the quickest start. The main fields:
   - `label`, `cli`: the display name, and the command users run themselves in a terminal.
   - `setup`: where credentials come from: `'account'` (it signs in itself), `'provider'` (a model provider) or `'first-use'`.
   - `modes`: which of Antumi's permission modes (`ask`, `acceptEdits`, `plan`, `auto`, `readOnly`, `bypass`) it has, named as its own users know them. Leave out the ones it lacks.
   - `startModes`, `defaultStartMode`: the modes a new conversation can start in, and the default.
   - `discussionMode`: the read-only mode for group chat members and issue investigations; `readOnlyMode`: the mode for a team's read-only members (not a planning mode).
   - `capabilities`: whether it can run unattended (schedules, routines), bypass approvals, load Antumi's skills and the user's MCP servers, and so on. When unsure, start with `false`.
   - `environment`: what it is for, how to install it, how to sign in. `usageWhere`: where to check usage.
   - `translations.en`: the interface is bilingual; the main fields hold Chinese, and the English for `modes`, `environment` and `usageWhere` goes here.
3. Register it in `AGENT_DESCRIPTORS` in `packages/protocol/src/agents/index.ts`.

## Step 2: core, make it run

Create the files under `packages/core/src/agents/<id>/`.

**An Agent that speaks ACP** needs one dialect (`<id>-dialect.ts`); the shared `AcpDriver` does the rest:

```ts
export const myDialect: AcpDialect = {
  name: 'My Agent',
  idPrefix: 'myagent',              // goes into request ids and logs; never change it
  modes: { ask: 'default', plan: 'plan' }  // Antumi's mode → its mode id
}
```

That is enough for plain ACP. Declare tool naming, questions and plan reviews (`permissionPrompt`), authentication methods, model lists, subagents and so on only as needed. References: OpenCode (`opencode/opencode-dialect.ts`, almost plain ACP), Kimi Code and CodeBuddy (moderate), Cursor (the most extensions).

**An Agent with its own protocol** implements `ChatDriver`. The smallest reference is Pi (`pi/pi-rpc.ts`): all state is derived from the frames `apply()` receives, so replaying a log and running live give the same chat items.

Then write the adapter (`<id>-adapter.ts`), following `kimi/kimi-adapter.ts`:

- Required: `kind`, `createDriver`, `command` (how to start it), `permissionModes` (must match the descriptor's `modes`), `session` (`preassignedId`, `folderBound`, `nativeFork`).
- Common optional fields: `detect` (finding it and reading its version), `installation` (install command), `catalog` (models), `signedIn`, `discovery` (executable and application names), `turns` (serialized sends, stopping the process after a cancel, retrying in a new process…).

Finally register it with `checkAdapter(...)` in `AGENT_ADAPTERS` in `packages/core/src/agents/index.ts`. If it was listed in `OTHER_AGENTS` (the "not yet supported" list) in `packages/core/src/environment-check.ts`, remove it from there.

Rules you must follow:

- The start command is an argv array and never goes through a shell.
- Never write `agent === '<id>'` outside its adapter. When it needs different behaviour, add a descriptor field or an adapter hook, and let the rest of the code ask those.
- No Electron or native modules in core. Keep platform checks explicit (such as `.cmd` shims on Windows).

## Step 3: icons

Add a one-colour icon in three places, with a comment saying where it came from (which official file):

- Desktop: in `packages/desktop/src/renderer/src/components/icons.tsx`, write a `<Name>Mark` component (`fill="currentColor"`) and register it in `AGENT_MARKS`.
- Phone: in `MARKS` in `packages/mobile/src/components/agent-mark.tsx`, add a `viewBox` and paths.
- README: `docs/assets/agents/<id>.svg`.

By now `pnpm typecheck` should pass: the three registries are all typed `satisfies Record<AgentKind, …>`, so missing one fails to compile.

## Step 4: optional capabilities

A first version can leave these out; say so in the PR:

| Capability | Where |
|---|---|
| Import the user's configured MCP servers | `core/src/mcp-import.ts`, desktop `McpSettingsSection.tsx` |
| Continue sessions the user ran in a terminal | the adapter's `transcripts` |
| Show the user's own skill folders | the adapter's `globalSkillDirs` |
| Read usage and use resets | the adapter's usage fields, the descriptor's `resetTracker` |
| Multiple accounts, third-party model providers | the descriptor's `capabilities.accounts` and `modelProviders`: these touch a lot, discuss in the issue first |

## Step 5: testing

**You can test without an account.** Many CLIs accept an API key plus a custom OpenAI-compatible base URL. Run a local mock model that answers by keyword with fixed replies (ask to run a command, ask a question), and full turns run with no real account and no network. That is how [CodeBuddy](CODEBUDDY.md#参考与验证) and [CodeArts](CODEARTS.md#参考与验证) were tested (Chinese).

**Record fixtures.** Let the real CLI talk to Antumi's driver and save both sides, one message per line, in `agents/<id>/fixtures/*.jsonl`:

```json
{"dir":"out","at":1,"frame":{"jsonrpc":"2.0","id":"myagent-init","method":"initialize","params":{}}}
{"dir":"in","at":2,"frame":{"jsonrpc":"2.0","id":"myagent-init","result":{}}}
```

Tests read a fixture, feed its messages to the driver in order and check the chat items it produces; see `kimi/kimi-acp.test.ts`. A new ACP dialect can also start from `acp/acp-driver.test.ts`. Replace local paths, user names and tokens in fixtures before committing.

Put a `<id>-recordings.md` in the same folder: the CLI version and recording date, the mock you used, what each fixture records, and what you replaced. See `kimi/fixtures/kimi-recordings.md`.

Worth covering: opening a session and the mode mapping, allowing and denying a command, questions and plan reviews (if it has them), resuming and replaying a session, the not-signed-in message, CLI detection.

Existing checks help:

- `agents/agent-registry.test.ts`: the adapter's permission modes match the descriptor, and every declared hook is implemented.
- `environment-check.test.ts`: may need the new Agent added to the expected detection results.

**Run all checks:**

```bash
pnpm typecheck && pnpm test && pnpm build
```

**Try it by hand:** run `pnpm dev` with a separate `ANTUMI_HOME` and check that:

1. Settings → External agents lists it with the right status (installed, not signed in, too old…).
2. A new conversation completes a turn.
3. Allowing and denying a command both work; if it has plan review, review a plan.
4. Switching permission mode and model works.
5. After stopping, continuing resumes the session.
6. A task started with it changes code in its worktree.

## Step 6: docs and the PR

- Create `docs/<AGENT>.md` following [Kimi Code](KIMI.md): requirements, permissions and boundaries, references and verification (which CLI version was tested, how fixtures were recorded).
- `README.md` and `README.en.md`: add it to the icon row and the Supported Agents table, and link its doc in the Using row.
- `docs/ARCHITECTURE.md`: at the end of 新增 Agent, add a paragraph on anything special about it (if there is).
- `CHANGELOG.md`: one sentence under `## 未发布` → `### 新功能` on what users can now see or do.
- Commit messages follow [CONTRIBUTING.md](../CONTRIBUTING.md#commit-messages), e.g. `feat: add CodeBuddy as an agent`, with a body on the protocol used and how it was tested.
- In the PR description: the CLI version and OS you tested, whether you used a real account, and what you did not test.

## Common questions

- **Its modes don't line up with Antumi's.** Map only modes with the same meaning and leave the rest out. `bypass` requires `capabilities.bypass`, and `auto` requires `autoMode`.
- **The protocol has fields Antumi fails to parse.** Loosen the parser in `acp/acp-schema.ts` with a test, rather than working around it in the dialect.
- **It doesn't speak ACP but runs a local HTTP server.** A bridge like CodeArts' is possible but sizeable; discuss it in the issue first.
