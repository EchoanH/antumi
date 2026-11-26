# 接入新的 Agent

[English](ADDING-AN-AGENT.en.md)

这份文档写给想让 Antumi 支持某个新 Agent（编程 CLI）的贡献者，按步骤走一遍。接入 Agent 要改 Antumi 的源码，和任务来源插件不同：来源插件不用改源码，见 [任务来源插件](PLUGINS.md)。

动手前先在 GitHub 开一个 Issue（设置 → 外部智能体底部的「提 Issue」会预填好模板），写清楚想接哪个 Agent、它的 CLI 怎么被程序驱动，避免和别人重复，也方便先对齐做法。实现细节和各注册表的完整说明在 [技术架构 → 新增 Agent](ARCHITECTURE.md#新增-agent)。

## 开始之前

**确认 CLI 能被程序驱动。** Antumi 不模拟终端操作，只通过结构化协议和 Agent 对话。常见三种：

| CLI 提供的接口 | 例子 | 能否接入 |
|---|---|---|
| ACP（Agent Client Protocol，如 `xxx acp`、`xxx --acp`） | Cursor、OpenCode、Kimi Code、Gemini CLI、CodeBuddy | 最容易：只写一份 dialect |
| 自有的 JSON-RPC 或流式协议（如 `app-server`、`--mode rpc`） | Codex、Pi、ZCode | 可以：要写自己的 driver |
| 只有交互式终端界面 | — | 不能 |

**摸清这些信息**，后面每一步都会用到：

- 启动命令和参数；需要哪些环境变量。
- 它有哪些权限或审批模式（询问、自动接受编辑、规划、全部放行……）。
- 会话：能否恢复、是否绑定启动目录、能否从某一轮分叉。
- 怎么登录、怎么判断已登录；怎么列出模型。
- 审批、提问和计划审批在协议里长什么样。

**准备开发环境。** 需要 Node ≥ 22.13 和 pnpm 12。

```bash
pnpm install
ANTUMI_HOME=~/.antumi-dev pnpm dev   # 独立实例，不碰 ~/.antumi 里的真实数据
```

`ANTUMI_HOME` 指向任意空目录即可，daemon、core 和桌面端会用它自己的数据库和 worktree。

## 第 1 步：protocol，描述它是什么

descriptor 是纯数据，core、桌面端和手机端共用。

1. 在 `packages/protocol/src/agent.ts` 的 `AGENT_KINDS` 末尾加上 id。id 用小写短名，定下后不要改：它会写进数据库和日志。
2. 新建 `packages/protocol/src/agents/<id>.ts`，导出一个 `AgentDescriptor`。从 `kimi.ts` 复制改起最快。主要字段：
   - `label`、`cli`：显示名和用户自己在终端里运行的命令。
   - `setup`：凭据来源，`'account'`（自己登录）、`'provider'`（模型服务商）或 `'first-use'`。
   - `modes`：Antumi 的权限模式（`ask`、`acceptEdits`、`plan`、`auto`、`readOnly`、`bypass`）里它有哪些，以及在它的用户眼里叫什么。没有的模式不写。
   - `startModes`、`defaultStartMode`：新会话可选的起始模式和默认模式。
   - `discussionMode`：群聊成员和排查问题时用的只读模式；`readOnlyMode`：团队里只读成员用的模式（不能是规划模式）。
   - `capabilities`：能否无人值守（定时、例程）、能否全部放行、是否加载 Antumi 的技能和用户的 MCP 服务器等。拿不准的先写 `false`。
   - `environment`：作用说明、安装命令、登录提示。`usageWhere`：去哪里看用量。
   - `translations.en`：界面是中英双语，`modes`、`environment`、`usageWhere` 的英文写在这里。
3. 登记进 `packages/protocol/src/agents/index.ts` 的 `AGENT_DESCRIPTORS`。

## 第 2 步：core，让它跑起来

在 `packages/core/src/agents/<id>/` 下新建文件。

**说 ACP 的 Agent**写一份 dialect（`<id>-dialect.ts`），通用的 `AcpDriver` 负责其余部分：

```ts
export const myDialect: AcpDialect = {
  name: 'My Agent',
  idPrefix: 'myagent',              // 写进请求 id 和日志，定下后不要改
  modes: { ask: 'default', plan: 'plan' }  // Antumi 的模式 → 它的模式 id
}
```

只用标准协议的话这样就够了。工具命名、提问和计划审批（`permissionPrompt`）、认证方式、模型列表、子 Agent 等按需声明，参照：OpenCode（`opencode/opencode-dialect.ts`，几乎只用标准协议）、Kimi Code 和 CodeBuddy（中等）、Cursor（扩展最多）。

**说自有协议的 Agent**要实现 `ChatDriver`。最小的参照是 Pi（`pi/pi-rpc.ts`）：所有状态都从 `apply()` 收到的帧算出来，所以从日志重放和实时运行得到同样的聊天条目。

然后写 adapter（`<id>-adapter.ts`），参照 `kimi/kimi-adapter.ts`：

- 必填：`kind`、`createDriver`、`command`（启动命令）、`permissionModes`（必须和 descriptor 的 `modes` 一致）、`session`（`preassignedId`、`folderBound`、`nativeFork`）。
- 常用可选：`detect`（怎么找到并检测版本）、`installation`（安装命令）、`catalog`（模型列表）、`signedIn`（是否已登录）、`discovery`（可执行文件名、应用名）、`turns`（串行发送、取消后停进程、换新进程重试等）。

最后在 `packages/core/src/agents/index.ts` 的 `AGENT_ADAPTERS` 里用 `checkAdapter(...)` 登记。如果它之前在 `packages/core/src/environment-check.ts` 的 `OTHER_AGENTS`（「暂未支持」清单）里，把那一项删掉。

必须遵守的规则：

- 启动命令是 argv 数组，永远不经过 shell。
- 不要在 adapter 以外写 `agent === '<id>'`。需要不同的行为时，在 descriptor 里加字段或在 adapter 里加 hook，其余代码只问它们。
- core 里不能引入 Electron 或原生模块。区分平台时写明确的判断（如 Windows 上的 `.cmd` 垫片）。

## 第 3 步：图标

三个地方各放一份单色图标，并在注释里写明来源（官方哪个文件）：

- 桌面端：`packages/desktop/src/renderer/src/components/icons.tsx`，写一个 `<Name>Mark` 组件（`fill="currentColor"`），登记进 `AGENT_MARKS`。
- 手机端：`packages/mobile/src/components/agent-mark.tsx` 的 `MARKS`，填 `viewBox` 和路径。
- README：`docs/assets/agents/<id>.svg`。

到这一步，`pnpm typecheck` 应该能通过：三处注册表都写成了 `satisfies Record<AgentKind, …>`，漏一处就编译不过。

## 第 4 步：可选能力

第一版可以不做，在 PR 里说明即可：

| 能力 | 要改的地方 |
|---|---|
| 导入用户已配置的 MCP 服务器 | `core/src/mcp-import.ts`，桌面端 `McpSettingsSection.tsx` |
| 继续用户在终端里跑过的会话 | adapter 的 `transcripts` |
| 显示用户自己的技能目录 | adapter 的 `globalSkillDirs` |
| 读取用量、使用重置 | adapter 的用量相关字段，descriptor 的 `resetTracker` |
| 多账号、第三方模型服务商 | descriptor 的 `capabilities.accounts`、`modelProviders`：牵涉较多，先在 Issue 里讨论 |

## 第 5 步：测试

**没有账号也能测。** 很多 CLI 支持用 API Key 加自定义的 OpenAI 兼容地址。起一个本地的模拟模型服务，按关键词回复固定内容（比如要求运行某条命令、提一个问题），就能在没有真实账号、不联网的情况下跑完整轮对话。[CodeBuddy](CODEBUDDY.md#参考与验证) 和 [CodeArts](CODEARTS.md#参考与验证) 就是这样测的。

**录制 fixture。** 让真实 CLI 和 Antumi 的 driver 对话，把双方的消息按行存进 `agents/<id>/fixtures/*.jsonl`：

```json
{"dir":"out","at":1,"frame":{"jsonrpc":"2.0","id":"myagent-init","method":"initialize","params":{}}}
{"dir":"in","at":2,"frame":{"jsonrpc":"2.0","id":"myagent-init","result":{}}}
```

测试读取 fixture，把消息依次交给 driver，检查生成的聊天条目，参照 `kimi/kimi-acp.test.ts`。说 ACP 的新 dialect 也可以先照 `acp/acp-driver.test.ts` 写。提交前把 fixture 里的本机路径、用户名、token 换掉。

在同一目录放一份 `<id>-recordings.md`，写明 CLI 的版本和录制日期、用的什么模拟服务、每份 fixture 录了什么、做过哪些替换，参照 `kimi/fixtures/kimi-recordings.md`。

建议覆盖：打开会话和模式映射、命令审批的允许和拒绝、提问和计划审批（如果有）、会话恢复和重放、未登录时的提示、CLI 检测。

已有的检查会自动帮你把关：

- `agents/agent-registry.test.ts`：adapter 的权限模式和 descriptor 一致，声明的 hooks 都有实现。
- `environment-check.test.ts`：可能需要把新 Agent 加进期望的检测结果。

**运行全部检查：**

```bash
pnpm typecheck && pnpm test && pnpm build
```

**手动试一遍：** 用独立的 `ANTUMI_HOME` 运行 `pnpm dev`，确认：

1. 设置 → 外部智能体里能看到它，状态正确（已安装、未登录、版本过旧等）。
2. 新建会话，跑完一轮对话。
3. 批准和拒绝一次命令；有计划审批的，走一次计划审批。
4. 切换权限模式和模型。
5. 停止后继续，会话能恢复。
6. 用它建一个任务并开始，在 worktree 里改动代码。

## 第 6 步：文档和 PR

- 新建 `docs/<AGENT>.md`，照 [Kimi Code](KIMI.md) 的结构写：运行要求、权限与边界、参考与验证（测过哪个 CLI 版本、fixture 怎么录的）。
- `README.md` 和 `README.en.md`：顶部的图标行、「支持的 Agent」表格各加一项，「使用」一行加上文档链接。
- `docs/ARCHITECTURE.md` 的「新增 Agent」末尾，用一段话写它的特别之处（如果有）。
- `CHANGELOG.md` 的 `## 未发布` → `### 新功能` 加一句话，写用户能看到什么。
- 提交信息按 [CONTRIBUTING.md](../CONTRIBUTING.md#提交信息) 的格式，比如 `feat: add CodeBuddy as an agent`，正文写清用的协议和测试方式。
- PR 描述写明：测过的 CLI 版本和操作系统、用没用真实账号、哪些没测到。

## 常见问题

- **它的模式和 Antumi 的对不上。** 只映射语义相同的模式；对应不上的不写。`bypass` 只有 `capabilities.bypass` 为真时才能有，`auto` 同理（`autoMode`）。
- **协议里有 Antumi 解析不了的字段。** 先在 `acp/acp-schema.ts` 里放宽解析，并补一条测试，不要在 dialect 里绕过去。
- **它不说 ACP，但有本地 HTTP 服务。** 可以像 CodeArts 那样写一个桥，但工作量较大，先在 Issue 里讨论。
