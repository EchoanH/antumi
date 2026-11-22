# 远程服务器（SSH）

> 状态：第一阶段进行中，分支 `feat/remote-ssh`。下面「第一阶段的步骤」逐项标出做到了哪里。

有的用户想让 Agent 跑在一台 Linux 服务器上：机器更强、开着不关、代码和数据本来就在那里。界面仍留在自己的电脑上。

## 做法：和 WSL 同一个形状，把 `wsl.exe` 换成 `ssh`

core 和 daemon 在服务器上以那台机器的用户运行，桌面端是它们的客户端。git、PTY、Agent、Antumi 的 MCP 服务、登录状态、用量和历史会话都在服务器上，和在本机时一样。

```
本机                                       服务器（Linux）
┌────────────────────┐   ssh（标准输入输出）  ┌──────────────────────────────┐
│ desktop（界面）     │── RPC（WebSocket）──▶│ core ── daemon ── Agent / PTY │
│ 内置浏览器的标签页   │◀─ 浏览器 host ───────│   └─ mcp.mjs（Agent 启动）     │
└────────────────────┘                      │ ~/.antumi（任务、会话、设置）   │
                                            └──────────────────────────────┘
```

WSL 已经把这条路走通了（[WSL.md](WSL.md)）：后端包、安装、替换旧 daemon、等 core 应答、经一个子进程的标准输入输出转发两个方向的连接。远程服务器复用这一切，只换掉「怎么在那台 Linux 上跑一条命令」：

- 安装、启动、问 core 在哪，这些步骤与通道无关（`desktop/src/main/linux-backend/`），WSL 和 SSH 各给它一个「在那台 Linux 上运行」的实现。
- 转发程序（`wsl-tunnel.mjs`）原样复用，由 `ssh host node wsl-tunnel.mjs` 启动。

其他项目和工具大多也是这么做的（VS Code Remote-SSH、Zed、Claude 桌面端、t3code、orca）。不选「服务器监听网络端口、桌面端直连」，因为那要另做加密和配对，暴露面也更大。这条路留给第二阶段：复用手机的 Noise 网关。

## 连接

- **用系统的 `ssh`**，不自己实现 SSH：用户的 `~/.ssh/config`、ssh-agent、跳板机、known_hosts 都照常生效。「服务器」一栏填的就是 `ssh` 认得的目标（`user@host`，或 config 里的别名）。
- 第一版只支持**不用输入密码的登录**（密钥在 ssh-agent 里，或密钥没有口令）：用 `BatchMode=yes`，有提示就直接失败并说明。没见过的主机密钥也会失败，提示用户先在终端里 `ssh` 一次。在应用内输入密码（askpass）放到以后。
- 每条命令都加 `-T`、`RemoteCommand=none`、`ClearAllForwardings=yes`：用户 config 里给交互登录配的远程命令和端口转发不能混进来。保活用 `ServerAliveInterval=15`。
- 除 Windows 外用 `ControlMaster`：一次握手，后面每条命令复用，套接字放在 `~/.antumi/ssh/`。问 core 在哪这类小命令因此很便宜。
- **远程命令一定经过对方的登录 shell**，这一点躲不开，而对方的 shell 可能是 bash、zsh 或 fish。所以 argv 先按 POSIX sh 的规矩转义，整段 base64 编码，再交给 `/bin/sh -c 'eval "$(echo … | base64 -d)"'`：对方 shell 看到的只有 base64 字符，任何 shell 都不会改动它。令牌和大块数据仍走标准输入，不进命令行。

## 安装和启动

和 WSL 相同（`linux-backend.ts`），只有三处不同：

1. **预检**多看两项：系统是 Linux（`uname -s`），架构是 x86_64 或 aarch64，分别用对应的后端包。
2. **启动**：WSL 靠一直开着的 `wsl.exe` 保住发行版；SSH 断开后后端要继续跑，所以在服务器上用 `setsid nohup … &` 脱离这次会话，输出接到 `~/.antumi/logs/`。
3. **logind**：主机设了 `KillUserProcesses=yes` 而用户没开 linger 时，SSH 一断 systemd 就会杀掉这个用户的所有进程，包括后端和正在跑的 Agent。预检发现这种情况就报出来，让用户执行 `loginctl enable-linger`。

后端包和 WSL 用的是同一种，多打一个 arm64 的，并随所有桌面端安装包一起带上（`resources/linux-backend/`，每个约 3MB）。版本目录、替换旧 daemon 的规矩、清理旧版本目录都沿用 WSL 的。

服务器上需要 Node 24 以上，和 WSL 一样。自带 Node 放到第一阶段的后半段（见下）。

## 路径和文件

core 只认服务器上的路径，本机的文件对它没有意义。WSL 能靠 `\\wsl.localhost` 直接读到发行版的文件，这里没有这条路，所以：

| 功能 | 远程时怎么做 |
| --- | --- |
| 选项目目录、选插件目录 | 在服务器上浏览目录（新 RPC），不开本机的对话框 |
| 文件预览 | 经 core 读，不读本机磁盘 |
| 拖进输入框的本地文件 | 作为附件上传（手机那套 `attachments.*`） |
| 用…打开 | VS Code、Cursor 用 `vscode-remote/ssh-remote+<host>` 链接，其他编辑器不显示 |
| 在访达中显示 | 不显示 |

## 内置浏览器

标签页仍在本机渲染，但网页的网络请求要从服务器发出，这样 Agent 在服务器上起的 `localhost:3000` 能直接打开。做法和 orca、codeg 一样：转发程序多开一个 SOCKS5 入口，由服务器那端去拨号；桌面端给内置浏览器的 session 设上这个代理。core 连浏览器 host 这一方向和 WSL 相同。

## 断线

- Agent、PTY 和 core 都在服务器上，断线不影响它们。
- 转发程序断了按退避重启（WSL 已有）；重连后界面重新拉取状态，和 core 重启后一样。
- 应用启动时连不上服务器，和 WSL 一样退回本机后端，并在列表上方提示「显示的是本机的任务」，后端位置页写明原因和怎么补。只退回界面：连不上之前没有任何东西要搬。
- 已经连上之后断开，不退回本机：界面像 core 重启时那样等它回来，转发程序在后台重连。

## 服务器上 Agent 的登录

第一版不代办：用户 ssh 上去自己登录（`claude`、`codex login`），或者在 Antumi 里给 Agent 配模型服务商。账号页在远程时说明这一点。

## 第一阶段的步骤

1. [x] 设计（本文）
2. [ ] 把 Linux 后端的安装和启动从 WSL 中抽出，与通道无关
3. [ ] SSH 通道：命令、预检、会话、后端位置里的「远程服务器」
4. [ ] 后端包：x64 和 arm64，随所有安装包带上
5. [ ] 在服务器上浏览目录，选项目
6. [ ] 预览、拖入文件、用…打开、在访达中显示
7. [ ] 内置浏览器经服务器上网
8. [ ] 自带 Node
9. [ ] 端到端：对着容器里的 sshd 从安装跑到界面连上

## 已知的限制

- **数据是两份**：本机和服务器的 `~/.antumi` 各有各的任务、会话和设置，切到哪边看到哪边。
- 一个界面一次只连一个后端。
- 服务器只支持 Linux。
