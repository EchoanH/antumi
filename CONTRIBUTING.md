# 参与贡献

[English](#contributing)

欢迎提 Issue 和 PR。

## 先开 Issue

改动较大时（新功能、接入新的 Agent 或聊天平台、改协议），先开一个 Issue 说明想做什么，对齐做法后再动手，免得白做。小的修复可以直接提 PR。

## 常见的贡献

- **接入新的 Agent**：按 [接入新的 Agent](docs/ADDING-AN-AGENT.md) 一步步来。
- **任务来源**（GitHub、Jira 之外的系统）：写一个插件，不用改 Antumi 源码，见 [任务来源插件](docs/PLUGINS.md)。
- **修 bug、改进功能**：先读 [技术架构](docs/ARCHITECTURE.md) 里相关的一节。进程边界、协议和安全规则写在 [AGENTS.md](AGENTS.md)，界面上的颜色、字号和间距按 [DESIGN.md](DESIGN.md)。

## 从源码运行

需要 Node ≥ 22.13 和 pnpm 12。

```bash
pnpm install
ANTUMI_HOME=~/.antumi-dev pnpm dev   # 独立实例，不碰 ~/.antumi 里的真实数据
```

## 提交前检查

```bash
pnpm typecheck && pnpm test   # 改了桌面端再加 pnpm build
```

新的行为要带测试。改动用户能注意到时，在 `CHANGELOG.md` 的 `## 未发布` 下加一句话（`### 新功能`、`### 改进` 或 `### 修复`），写用户现在能看到或做到什么，规则见 [AGENTS.md](AGENTS.md#changelog)。

## 提交信息

用精简版的 Angular 格式：

```
<type>(<scope>): <summary>

<body>
```

- **type**：`feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`build` 或 `chore`。
- **scope**：改动所在的包，`protocol`、`core`、`daemon` 或 `desktop`；跨多个包时省略。
- **summary**：英文祈使句，首字母小写，不加句号，72 个字符以内。
- **body**：为什么要改、行为和之前有什么不同。`docs` 和 `chore` 可以省略。

一个提交只做一件事，测试和代码放在同一个提交里。完整规则见 [AGENTS.md](AGENTS.md#commits)。

## PR

写清楚改了什么、为什么改、怎么验证的。涉及界面的附截图，只在部分平台上测过的注明平台。

---

# Contributing

Issues and pull requests are welcome.

## Open an issue first

For larger changes (a new feature, a new Agent or chat platform, a protocol change), open an issue describing what you want to do and agree on the approach before you start. Small fixes can go straight to a PR.

## Common contributions

- **Adding a new Agent**: follow [Adding a new Agent](docs/ADDING-AN-AGENT.en.md) step by step.
- **Task sources** (systems beyond GitHub and Jira): write a plugin, no changes to Antumi's source needed, see [Task source plugins](docs/PLUGINS.md).
- **Bug fixes and improvements**: read the relevant section of [Architecture](docs/ARCHITECTURE.md) (Chinese). Process boundaries, protocol and safety rules are in [AGENTS.md](AGENTS.md); colours, type and spacing follow [DESIGN.md](DESIGN.md).

## Running from source

You need Node ≥ 22.13 and pnpm 12.

```bash
pnpm install
ANTUMI_HOME=~/.antumi-dev pnpm dev   # a separate instance that leaves ~/.antumi alone
```

## Before you submit

```bash
pnpm typecheck && pnpm test   # plus pnpm build for desktop changes
```

New behaviour comes with tests. When users can notice a change, add one sentence under `## 未发布` in `CHANGELOG.md` (`### 新功能` for new features, `### 改进` for improvements, `### 修复` for fixes) on what they can now see or do. Chinese is preferred there, since it becomes the release notes; the maintainers can translate. See [AGENTS.md](AGENTS.md#changelog).

## Commit messages

A trimmed version of Angular's format:

```
<type>(<scope>): <summary>

<body>
```

- **type**: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build` or `chore`.
- **scope**: the package, `protocol`, `core`, `daemon` or `desktop`; leave it out when the change spans packages.
- **summary**: imperative, lowercase first letter, no trailing period, under 72 characters.
- **body**: why the change is needed and how behaviour differs from before. Optional for `docs` and `chore`.

One self-contained change per commit, with its tests. The full rules are in [AGENTS.md](AGENTS.md#commits).

## Pull requests

Say what changed, why, and how you verified it. Add screenshots for interface changes, and name the platforms you tested if not all.
