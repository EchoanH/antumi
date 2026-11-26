# Lark 资料接入（设计）

> 状态：设计，未实现。来自 [#11](https://github.com/flyhero/antumi/issues/11)。Meegle（飞书项目）作为任务来源另起一期，不在本文。B 节 2026-11-26 改为接飞书官方 MCP、读写都可（原先是只读、自己实现工具）。

让智能体使用 Lark（含飞书）的文档、知识库和多维表格。分两种用法，安全模型完全不同：

| | 谁在用 | 用什么身份 | Antumi 要做的 |
|---|---|---|---|
| A. 自己用的智能体 | 主人本人 | 主人自己（`lark-cli` 登录），或应用 | 推荐技能 + 使用说明，不写新功能 |
| B. 接到聊天平台的智能体 | 在飞书里 @ 机器人的同事 | 机器人（应用身份，tenant_access_token） | 转接飞书官方 MCP，主人勾选开放的工具，Antumi 附上凭据 |

主人自己的身份（他登录的 `lark-cli`）只在主人同意之后、在他开始执行的任务里用，见 CHANNELS.md「主人在聊天平台上同意」。

文中「Lark」同时指飞书和 Lark：两者接口相同，只是开放平台域名不同（见「平台差异」）。

## A. 自己用的智能体：官方 CLI + 技能

Lark 官方的 `lark-cli`（npm `@larksuite/cli`，MIT）覆盖文档、知识库、多维表格等，仓库 `larksuite/cli` 的 `skills/` 带有 `lark-doc`、`lark-wiki`、`lark-base`、`lark-shared`（认证与身份，其他技能都依赖它）等 Agent 技能。`larksuite/meegle-cli`（MIT）同理，带 `skills/meegle`。

Antumi 的技能库已经能装这两个仓库（`git clone` 后先扫 `skills/`，见 ARCHITECTURE.md 的技能一节），所以只做两件事：

1. `packages/core/src/skills-recommended.ts` 加两条推荐：
   - `https://github.com/larksuite/cli`，`skills: ['lark-shared', 'lark-doc', 'lark-wiki', 'lark-base']`，说明里写「需要先安装 lark-cli 并登录」。
   - `https://github.com/larksuite/meegle-cli`，`skills: ['meegle']`，说明同上。
2. 本文这一节作为使用说明，桌面端推荐卡片的主页链接指向官方仓库。

使用步骤（写给用户）：

1. `npm install -g @larksuite/cli`；`lark-cli config init --brand lark`（飞书用 `feishu`），填自建应用的 App ID / Secret。可以用聊天平台接入的同一个应用。
2. 选身份：`lark-cli auth login`（设备码，本人授权）后默认以本人身份；不登录则以应用身份（`--as bot`），只能读分享给应用的内容。lark-cli 的规则是有未过期的用户令牌就用用户，否则用应用。
3. 「设置 → 任务 → 技能」安装推荐的 Lark 技能，按 Agent 启用。

要知道的：

- Antumi 不替用户装 CLI、不代管它的登录，也不改 `~/.claude`、`~/.agents` 等目录。
- 这台电脑上所有能执行命令的 Agent 共用这份授权，包括「全部放行」的会话。只查资料就只申请读权限。
- Codex、Antigravity 收不到 Antumi 交的技能，靠各自的全局技能目录（ARCHITECTURE.md「本机技能」）。
- 应用身份查本人资源时 lark-cli 会返回空的成功而不是报错（`lark-shared` 技能原文），查不到时先确认身份。

## B. 聊天平台上的智能体：以机器人身份用飞书 MCP

### 原则

- **机器人的权限由主人决定**：它在飞书开放平台开了哪些权限、哪些文档和知识库分享给了它、哪些人能 @ 它（接入的 `allowedUsers` / `allowedPlaces`），都是主人的选择。Antumi 不另设资料白名单，也不替主人判断它该读写哪些东西。
- **开放哪些工具由主人勾选**，默认一个都不开；打开时把风险讲清楚（见「风险说明」）。
- Antumi 只守三件事，都不是限制机器人的权限：
  1. **凭据不交给智能体**：App Secret 和 tenant_access_token 只在网关里，调用时由网关附上。智能体能用机器人的权限，拿不到凭据本身，没法把它带走或贴出去。
  2. **只用机器人的身份**：从不带主人或提问人的用户令牌。主人本机登录的 `lark-cli`、`meegle-cli` 是主人的身份，不是机器人的，聊天平台上的会话碰不到（它们本来就没有命令行，见 CHANNELS.md「外部会话」）。
  3. **每次调用都记录**：谁问的、调了哪个工具、目标是哪份资料，记进提问记录，和项目读取一样。
- 不做：用提问人身份（见「以后：提问人身份」）；把 `lark-cli` 交给聊天平台上的会话；Slack、钉钉（各自另做，机制相同）。

### 为什么用 MCP，不用 lark-cli

| | lark-cli | 飞书官方 MCP |
|---|---|---|
| 聊天平台上的会话能不能用 | 要给它开命令行，等于交出主人整台电脑 | 会话本来就只用 MCP 工具，转接进来即可 |
| 只开放一部分 | 要逐条命令封装 | 官方 MCP 本身按名单开放工具（不给名单就一个都不列），直接做成勾选项 |
| 身份不串 | 不写 `--as` 时，本机登录了用户就优先用用户身份 | 每个请求固定带机器人的 token |
| 凭据 | 在主人本机 CLI 的配置里 | 网关附上，智能体看不到 |

### 两个 MCP，分两期

| | 一期：托管 MCP | 二期：`lark-openapi-mcp` |
|---|---|---|
| 是什么 | 飞书托管的远程 MCP：`https://mcp.feishu.cn/mcp`（Lark 对应 `mcp.larksuite.com`，待核实） | 官方开源的本地 MCP（npm `@larksuiteoapi/lark-mcp`），网关以子进程启动，stdio 通信 |
| 身份 | 请求头 `X-Lark-MCP-TAT` 带应用 token | 启动参数 `--token-mode tenant_access_token`，不用 `auto`（`auto` 会在用户令牌和应用令牌之间切换） |
| 开放哪些工具 | 请求头 `X-Lark-MCP-Allowed-Tools`，没有它一个工具都不列 | 启动参数 `-t`，按工具或预设（如 `preset.base.default`） |
| 工具 | 云文档：读 `fetch-doc`、`list-docs`、`get-comments`、`fetch-file`、`get-user`；写 `create-doc`、`update-doc`、`add-comments`（整篇评论，不能 @ 人）。`search-doc`、`search-user` 只支持用户身份，机器人用不了 | 多维表格、知识库、消息、日历等开放平台接口；**不能直接编辑文档**（只能导入），所以文档仍走托管 MCP |
| 状态 | 正式提供 | 官方标为 beta |

lx 的需求最急的是「把方案写成飞书文档并返回链接」，所以先做托管 MCP。多维表格、知识库浏览放二期。搜索暂时没有机器人身份能用的工具：同事贴链接，或者到二期用知识库目录浏览；原设计里未公开的 Search v2 接口不再采用。

### 整体流程

```
同事 @ 机器人 ─► 网关 ─► core 入站检查（已有）─► 锁死的智能体
                                                    │ lark_* 工具（Antumi 的 channel MCP 列出主人勾选的那些）
                                                    ▼
                         core：开关、当前提问在跑、提问人和所在的群仍在授权范围、组织未变
                                                    │ IPC mcp 请求
                                                    ▼
                         网关（飞书连接器）：取 tenant_access_token，附 X-Lark-MCP-TAT 和工具名单
                                                    │ JSON-RPC tools/call
                                                    ▼
                                             mcp.feishu.cn
                                                    │ 结果或错误
                                                    ▼
                         core：截断、记进 channel_tool_calls、作为资料交回 ─► 智能体回答 ─► 打码 ─► 飞书
```

### 协议（`protocol/src/channel.ts`、`channel-platforms.ts`）

- `ChannelFields` 加 `platformTools: z.array(z.string().max(100)).max(50).optional()`：主人勾选开放的平台工具，用平台的原名（如 `create-doc`）。没有或为空就是不开。名字不带 Lark：Slack、钉钉以后的同类能力沿用。保存时没带这个字段的旧客户端保留已有值。
- 平台描述加可选的 `tools?: { mcp: string; scopes: string[]; catalog: { name: string; write: boolean; label: string; translations? }[] }`：远程 MCP 的地址、开这些工具要在开放平台额外开通的权限、可勾选的工具（`write` 用来在界面上分组和提示）。只有 `feishu`、`lark` 有。目录写在描述里而不是每次现取：桌面端离线也能显示，飞书新增的工具要随 Antumi 更新才出现。
- `CORE_FEATURES` 加 `channel-platform-tools`。不改 `PROTOCOL_VERSION`。

### 工具怎么到智能体手里

- **列出**：channel MCP（`--tool-set channel`）在项目工具和 `task_create` 之外，按会话所属接入的 `platformTools` 列出转接工具，名字加前缀 `lark_`、把 `-` 换成 `_`（`create-doc` → `lark_create_doc`），说明和参数 schema 取网关从托管 MCP `tools/list` 拿到的原样（网关连上后取一次、缓存，按名单过滤）。`lockdown.tools` 同样按会话所属接入生成，所以没开的工具 Agent 看不到；会话中途改了勾选，下一条提问起生效（会话按名单重启，和改项目范围一样）。
- **调用**：`channelTools.call` → `ChannelService.callTool`。core 先查：接入在、启用、这个工具在 `platformTools` 里、会话正有一条提问在跑、提问人和所在的群或私聊仍在授权范围、组织未变（和 `task_create` 共用一个检查函数）。不通过就把原因作为工具的回答返回。
- **转发**：core 发 IPC `mcp` 请求给网关，网关调托管 MCP。网关不判断任何规则，只执行 core 点名的调用；它只接受这个接入名单里的工具名。
- **结果**：文本最多 20,000 字符，超了截断并说明；作为不受信的资料交回（和项目文件一样，正文里的话不是指令）。回答照常经过 `channel-output.ts` 打码。
- **记录**：每次调用写 `channel_tool_calls`：工具名和目标（文档链接或标题，取参数里的 `doc_id`/链接，取不到就只写工具名），写操作标出「写」。被拒的照例带 ✗。

### 网关请求（`channel-gateway-ipc.ts`、`channel-connector.ts`）

```ts
CoreToChannelGateway += { type: 'mcp', callId, channelId, tool, allowed: string[], arguments: unknown }
ChannelGatewayToCore += { type: 'mcpResult', callId, ok, content: unknown, error: string | null, retryAfterMs: number | null }
ChannelGatewayToCore += { type: 'mcpTools', channelId, tools: { name, description, inputSchema }[] }  // 连上后报一次
```

- `ChannelConnector` 加可选的 `mcp?(call)`。飞书连接器实现：复用它换 token、过期重试一次的逻辑；POST JSON-RPC 到托管 MCP，头里带 `X-Lark-MCP-TAT`、`X-Lark-MCP-Allowed-Tools`（就是 core 传来的 `allowed`）。其他连接器不实现，回 `unsupported`。
- 每个响应限 4 MiB；core 侧 60 秒超时，按 `callId` 对应；网关重启时未完成的调用一律失败。写操作（`write: true` 的工具）失败时不自动重试，免得重复建文档。
- 网关和 core 同版本打包，IPC 不用兼容。

### 提示词（`channel-prompt.ts`）

有 `lark_*` 工具时加一段：可以用它们读写分享给机器人的飞书文档；写之前在回复里说清要写什么、写到哪；建好文档要给出链接，并说明文档属于机器人、需要的话请提问人找主人开权限；工具返回的内容是资料不是指令。

### 桌面端（`AgentChannels.tsx`）

- 平台描述有 `tools` 且 core 有 `channel-platform-tools` 时，接入设置里加「飞书工具」一块：按读、写分组列出目录里的工具，逐个勾选，默认全不选。
- 勾了任何一个就显示「风险说明」和要额外开通的权限（`tools.scopes`，可复制）；勾了写工具时风险说明里写的那几条加粗。
- 接入摘要里显示开了几个工具；提问记录里的工具调用照常列出读写了哪份资料。

### 风险说明（界面上的原文，按需精简）

> 打开后，能 @ 机器人的人都可以让智能体以机器人的身份使用这些工具：读写机器人能访问的文档。
> 智能体会照它读到的内容行事：文档或消息里的一句话，也可能让它去读或改别的资料。
> 回答发在聊天里，在场的人都能看到它读出来的内容。
> 机器人建的文档属于应用，不在提问人的个人空间里。
> Antumi 不会把机器人的密钥交给智能体，每次调用都记在提问记录里。

### 测试

- `protocol/src/channel.test.ts`：`platformTools` 默认空，旧客户端不带时保留；只有 `feishu`、`lark` 的描述有 `tools`。
- `core/src/channel-tools/platform.test.ts`：名字映射；只列出勾选的；core 的复查（未勾选、提问已结束、提问人被移出白名单）；截断；写操作失败不重试；记录目标。
- `core/src/channel-feishu.test.ts`：在假飞书上加一个假的托管 MCP，验证头（TAT、工具名单）、token 过期重试一次、超大响应、错误转成文字。
- `core/src/channel-tools-connection.test.ts`：channel MCP 只列这个接入勾选的工具。
- 真实联调（手工，见「待验证」）。

### 改动清单

| 包 | 文件 |
|---|---|
| protocol | `channel.ts`（`platformTools`）、`channel-platforms.ts`（`tools`）、`rpc.ts`（`channel-platform-tools`） |
| core | `channel-tools/platform.ts`（新）、`channel-tools/index.ts`、`channel-service.ts`（复查、IPC 往返）、`channel-gateway-ipc.ts`、`channel-gateway.ts`、`channel-connector.ts`、`channel-feishu.ts`、`mcp-channel-tools.ts`、`conversation-service.ts`（按接入取工具名单）、`channel-prompt.ts`、`skills-recommended.ts`（A） |
| desktop | `AgentChannels.tsx`、i18n |
| docs | 本文、CHANNELS.md、CHANGELOG |

CHANGELOG（`### 新功能`）：

```
- 飞书和 Lark 接入可开放飞书工具：同事 @ 机器人时，它能以机器人身份读写分享给它的飞书文档，开放哪些由你勾选。
```

建议拆成：A（推荐技能）；工具名单按接入生成（不带新工具）；托管 MCP 转接与设置。

## 待验证（动手前）

用 2026-11-15 联调过的飞书应用实测，先只调读：

1. 用应用 token 调托管 MCP：`tools/list` 带和不带 `X-Lark-MCP-Allowed-Tools` 各返回什么；记下每个工具的参数和返回格式，回填「两个 MCP」一节。
2. `fetch-doc` 读一篇分享给应用的文档、一篇没分享的，看没权限时的错误形式；读一篇带表格、图片、嵌入多维表格的文档，看 Markdown 效果。
3. `create-doc` 建一篇：建在哪里（能否指定文件夹或知识库节点）、所有者是谁、提问人能否打开；`update-doc` 追加内容；`add-comments`。
4. 核实 Lark 的托管地址，以及 `X-Lark-MCP-TAT` 在 Lark 上是否同样可用。
5. 二期前：`lark-openapi-mcp` 以 `tenant_access_token` 模式跑多维表格和知识库的预设，确认不会改用用户令牌。

## 以后：提问人身份

只在需要「读提问人自己能看的内容」时考虑，且**只在私聊**：群里的回答谁都能看到，用提问人身份读也照样泄露给群里的人。照 Lark 官方 OpenClaw 插件的做法：

- 设备码授权：`POST https://accounts.<brand>/oauth/v1/device_authorization`（Basic `app_id:app_secret`，`scope` 加 `offline_access`），轮询换 token。这一套没有公开文档，只在 lark-cli 和官方插件的代码里，接入前要再核实。
- 授权链接以卡片发给提问人；拿到 token 后用 `authen/v1/user_info` 核对 `open_id` 是提问人本人，防止别人点了链接把自己的身份绑上去。
- token 按 `应用:open_id` 存进 core 的凭据库（0600），不进 Agent 的上下文。access_token 约 2 小时；refresh_token 7 天、只能用一次、每次刷新都换新，需要按用户加锁刷新；365 天必须重新授权。
- 官方插件把这种模式硬性限定给应用所有者，其他人一律拒绝。我们若做，至少要同样限定或让主人逐个授权。

## 平台差异

| | 飞书 | Lark |
|---|---|---|
| 开放平台 | `https://open.feishu.cn` | `https://open.larksuite.com` |
| 授权服务（用户身份才用） | `accounts.feishu.cn` | `accounts.larksuite.com` |
| 资料域名 | `<租户>.feishu.cn`，`larkoffice.com` 是别名 | `<租户>.larksuite.com` |

接口路径、权限名、错误码两边相同。开放平台按品牌固定，不随租户域名变。

## 接口依据

- 托管 MCP：[开发者调用远程 MCP](https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server?lang=zh-CN)（`X-Lark-MCP-TAT`、`X-Lark-MCP-UAT`、`X-Lark-MCP-Allowed-Tools`）、[支持的工具](https://open.feishu.cn/document/mcp_open_tools/supported-tools?lang=zh-CN)。用应用身份时，应用也要被授予每份文档或知识库的访问权限。
- `lark-openapi-mcp`：[README](https://github.com/larksuite/lark-openapi-mcp)（`--token-mode`、`-t` 工具与预设；不支持直接编辑文档和上传文件）。
- 个人 MCP 令牌那条路（`mcp.feishu.cn` 的个人链接）正在由飞书 CLI 取代，2026-02-24 起链接 7 天过期，和这里无关：这里只用应用身份。
- 应用要读写一份资料，必须同时满足：开通了对应权限（企业管理员审批），并且这份资料对应用可见：所有者或管理者用「添加文档应用」加了它、分享给了含机器人的群、开了「组织内获得链接的人可阅读/编辑」，或知识库把应用加为成员（覆盖整个空间）或某个节点的协作者（覆盖该节点及子节点）。多维表格开了高级权限时要「可管理」。
- 原设计自己调开放平台接口（`docs/v1/content`、`wiki/v2`、`bitable/v1`、未公开的 Search v2）的细节见本文件的 git 历史（2026-11-21 版）；二期若 `lark-openapi-mcp` 不合用，可以回到那套。

## 调研（2026-11-21）

| 项目 | 读资料的身份 | 文档怎么读 | 权限与群聊 |
|---|---|---|---|
| OpenClaw 自带飞书扩展（`openclaw/openclaw` 的 `extensions/feishu`，源自 m1heng） | 只用应用身份 | `raw_content` 纯文本 + 标题 + 块列表，Markdown 只用于写入 | 按工具族的开关（`tools.doc/wiki/drive/bitable` 默认开，`perm` 默认关），注册时隐藏、调用时再查；知识库为空时提示把机器人加为成员；触发由群白名单、必须 @、发送人白名单控制，读文档不再看提问人 |
| m1heng/clawdbot-feishu | 只用应用身份 | 同上 | `99991672` 时从错误里取申请链接告诉用户（只用在通讯录接口上） |
| Lark 官方 OpenClaw 插件 `@larksuite/openclaw-lark` | 读资料一律用户身份，应用身份只用于发评论 | Lark 托管的 MCP（`mcp.feishu.cn` / `mcp.larksuite.com`）的 `fetch-doc`，返回 Markdown | 只有应用所有者能用，其他人得到 `permission_denied`；授权是设备码 + 群里的卡片，核对 `user_info`；token 存钥匙串，按用户加锁刷新；缺权限时自动发授权卡片 |
| `larksuite/cli` | 每个命令声明支持的身份，`--as user\|bot`，有用户令牌优先用户 | 未公开的 `docs_ai/v1/documents/:token/fetch` | 为 Agent 设计了 `--no-wait` 先发链接、下一步再取 token 的登录 |

本地的 multica、codeg、opensquilla 接了飞书或 Lark，都只收发消息，没有读资料。

## 调研（2026-11-25）

聊天平台上的编程 Agent 和本地开源项目怎么处理「机器人替谁干活」：

| | 在聊天平台里用什么身份 | 谁能触发、怎么保护 |
|---|---|---|
| Claude Tag（原 Claude Code in Slack） | 频道里用服务账号，按频道配凭据；私聊才用本人账号 | 管理员决定给哪些频道什么凭据，并明说「频道里谁都能让 Claude 用这份凭据干活」；凭据在出口代理附上，不进沙箱；其他人的消息只当资料 |
| Cursor | 团队服务账号 | 先绑定账号；可限定只有发起人能追问 |
| Codex | 发起人绑定的账号 | 要授权的操作只给发起人弹 Allow/Deny 卡片 |
| GitHub Copilot | 频道里用应用身份 | 对仓库有写权限的人才能触发；频道里开的 PR 多一次批准 |
| multica | 每人绑定账号，检查是否有权调用这个智能体 | 一个任务一张卡片，思考 → 输出 → 完成 |
| opensquilla | 机器人 + 白名单 | 非主人看不到敏感工具；授权卡片只本人能点，「总是允许」只有管理员；刻意不给机器人申请文档权限，文档走飞书 MCP / CLI |
| lobehub | 主人 | 应用身份只读文档（文档要分享给应用） |

飞书官方的 `lark-cli` 和 OpenClaw 插件都建议不要把接了它们的机器人拉进群。OWASP「过度代理」（LLM06:2025）和 Meta 的「二选一」原则都主张最小权限、高影响操作要人批准。本文的取舍：权限范围交给主人（Claude Tag 的做法），Antumi 只保证凭据不交给智能体、不用主人身份、每次调用有记录。
