# WSL 支持

> 状态：设计中，未实现。下面带「待验证」的都没有在 Windows 上跑过。

Windows 用户里有一类人整天在 WSL 里干活：项目放在发行版自己的目录里（`/home/<用户>/...`），Claude Code、Codex 这些 CLI 也只装在里面。Windows 上的 Antumi 只在 Windows 里找 Agent，于是一个都找不到。

## 做法：后端跑在 WSL 里，Windows 只留界面

core 和 daemon 在发行版里以 Linux 进程运行，Windows 的桌面端作为客户端连过去。git、PTY、Agent、Antumi 的 MCP 服务、登录状态、用量和历史会话都是 Linux 下的原样行为，各 Agent 的 adapter 不用改。

```
Windows                                   WSL 发行版
┌────────────────────┐                    ┌──────────────────────────────┐
│ desktop（界面）     │── RPC（WebSocket）─▶│ core ── daemon ── Agent / PTY │
│ 内置浏览器的标签页   │◀─ 浏览器 host ──────│   └─ mcp.mjs（Agent 启动）     │
└────────────────────┘                    │ ~/.antumi（任务、会话、设置）   │
                                          └──────────────────────────────┘
```

这条路现成可走，因为进程边界本来就是这样划的：core 不依赖 Electron，桌面端只是客户端，原生模块只在 daemon 里。`mcpCommand` 用 `process.execPath` 加 `ANTUMI_MCP_JS` 启动 MCP 服务（`core/src/mcp-command.ts`），换成 Linux 的 Node 不用改。

### 为什么不是「后端留在 Windows，每条命令经 `wsl.exe` 转进去」

那是架构文档里原先写的 `hostId` 执行宿主。它要在 Windows 和 Linux 之间逐处转换路径和环境变量，并且对每个 Agent 单独处理登录状态、用量和历史会话的位置。读过的两个实现：

- Orca 这样做，约 2400 个文件提到 WSL：路径手写转换，git 分三种方式运行，另往发行版里装两个小程序接 Agent 回调和转发浏览器流量。
- ChatGPT 桌面版（Codex）这样做，官方文档写明从 `\\wsl$` 打开的项目识别不到 git，建议把项目放回 Windows 盘。

VS Code、Cursor、JetBrains、Zed、Claude 桌面版和 T3 Code 走的都是后端进发行版。

## 第一版的范围

选好发行版就能用：桌面端自己把后端装进发行版、启动它、跟着应用升级，内置浏览器可用。用户要自己准备的只有发行版里的 Node 和各 Agent 的 CLI。

### Linux 后端包

发版时在 Linux 上打出 `backend-linux-x64.tar.gz`，放进 Windows 安装包的资源里。内容是 `out/backend` 的全部 `.mjs`、`plugins`、Linux 上编译的 node-pty（Linux 安装包的构建已经会编），和下面说的转发程序。用发行版里已有的 Node 运行，不自带 Node；node-pty 1.1.0 走 N-API，不要求 Node 版本一致。

### 安装和启动

接在现有的 `ensureBackend` 上（`desktop/src/main/backend.ts`），「后端位置」选了发行版时走这一支：

1. **预检**：发行版存在、是 WSL 2、有 Node、node-pty 能加载。不满足时说清缺什么，并退回本机后端。
2. **安装**：版本目录 `~/.antumi/backend/<版本>/` 不在时，把后端包经标准输入送进发行版解开，校验 sha256，最后写就绪标记。
3. **取 PATH**：取一次发行版登录 shell 的 PATH，同 `loginShellPath` 的 Linux 分支。
4. **启动**：daemon 和 core 各由一个分离的 `wsl.exe -d <发行版> --exec env PATH=… node …` 带起来，和本机 `launch()` 的 `detached` 一样不随应用退出。Linux 进程留在 `wsl.exe` 的前台，不在发行版里再做一次后台化：有 `wsl.exe` 连着，发行版才不会被回收（待验证 1）。
5. **替换**：core 的版本和应用不一致时，沿用 `retireCore` / `retireOldDaemon` 的规矩，daemon 只在不跑东西时才换。

桌面端读端口和令牌用 `wsl.exe --exec cat ~/.antumi/core.json`，不从 Windows 直接读 `\\wsl.localhost`：Orca 记录过它的 stat 会误报文件不存在。

### 连接

Antumi 自己的协议都不变，变的只是字节怎么过 Windows 和发行版之间的那道边界。

- **界面 → core**：先直接连 `127.0.0.1:<端口>`，Windows 默认会把它转进发行版。连不上时改走转发程序。
- **core → 内置浏览器**：发行版里连不到 Windows 的 `127.0.0.1`（默认网络模式下），所以必须走转发程序。

转发程序是后端包里的一个小 Node 脚本，由桌面端经 `wsl.exe` 启动，字节走这个子进程的标准输入输出，不经过网络（Zed 的远程连接、Orca 的浏览器转发都这样走）。浏览器这一条：它在发行版的 `127.0.0.1` 上开一个端口，把连进来的连接转给桌面端主进程，主进程再连本机的浏览器 host；同时把这个端口和 host 的令牌写进发行版的 `~/.antumi/browser/host.json`，core 照原样去读、去连（`core/src/browser-service.ts`），不用改。它在标准输入关闭时退出并删掉那个文件。

core 仍然只绑 `127.0.0.1`。T3 Code 为了绕开不可靠的 localhost 转发让服务端监听 `0.0.0.0`，这里不能照做。

### 路径

core 只认 Linux 路径，转换只发生在桌面端这几处 IPC（`desktop/src/main/index.ts`）：

- `antumi:pick-folder`：对话框开在 `\\wsl.localhost\<发行版>\home\<用户>`，选中的路径转成 Linux 路径再交给 core。
- `antumi:reveal-file`、`antumi:open-file`、`antumi:open-with`：Linux 路径转成 `\\wsl.localhost\<发行版>\...` 再交给系统。
- 拖进输入框的 Windows 文件：`C:\x` 转成 `/mnt/c/x`。

### 这一版没有的

局域网里的手机直连（WSL 默认网络下外面连不进发行版）、保持唤醒、自带 Node。

## 实现顺序

没有 Windows 机器，所以每一步都先让能验证的部分落地：

1. 一个给用户跑的验证脚本，确认「待验证」的 1 和 2。结果决定第 4 步怎么启动。
2. 调用 `wsl.exe` 的模块：列发行版、跑命令、取 PATH，按下面的规矩写，带单元测试。
3. Linux 后端包进发版流程和 Windows 安装包。
4. 预检、安装、启动、替换，接进 `ensureBackend`。
5. 「后端位置」设置和路径转换。
6. 转发程序和内置浏览器。
7. 测试版发给用 WSL 的用户，再正式发。

## 已知的限制

- **数据是两份**。Windows 的 `~/.antumi` 和发行版里的 `~/.antumi` 各有各的任务、会话和设置，「后端位置」切到哪边就看到哪边的。同时连两个后端不在这份设计里。
- **只支持 WSL 2**，一次一个发行版。
- 项目放在 `/mnt/c/...` 下也能用，但 git 和文件监听会慢，建议放在发行版自己的目录里。

## 调用 `wsl.exe` 的规矩

从 Orca 和 T3 Code 踩过的坑里抄来的，实现时集中在一个模块里：

- 用绝对路径的 `System32\wsl.exe`，并给它一个确定存在的 Windows 工作目录。
- 一律 `--exec`，不用 `--`：后者会把每个参数里的 `$name` 展开。
- 设 `WSL_UTF8=1`，否则 `wsl.exe` 自己的报错是 UTF-16LE。
- `--exec` 拿不到登录 shell 的 PATH，要先取一次再显式带上；取的时候用标记把输出夹起来，Ubuntu 的登录 shell 会往标准输出打提示。
- 令牌走标准输入，不进命令行参数。
- 后台检查不要把已经停掉的发行版唤醒：先看 `wsl.exe --list --running`。
- `wsl.exe --list` 的输出是 UTF-16LE 带 BOM；`docker-desktop` 这类发行版要滤掉。
- 「没问到」不等于「没有」：探测失败时保留上一次的结果，过一会儿再问。

## 待验证

动手前要在 Windows 11 + WSL 2（Ubuntu 24.04）上确认的：

1. **发行版会不会在桌面端退出后被停掉**。WSL 在没有 `wsl.exe` 会话连着时会回收发行版，后台进程跟着没。Antumi 的规矩是关窗口、退出应用都不碰正在跑的 Agent，所以要弄清楚怎样让发行版留着（留一个 `wsl.exe` 子进程、systemd，或者别的），以及做不到时怎么告诉用户。
2. Windows 连发行版里绑在 `127.0.0.1` 上的 core，在默认网络和镜像网络两种模式下是否都通。T3 Code 的注释说部分机器上不可靠。
3. 发行版里的 daemon 用 Unix socket、core 和各 Agent 的启动，是否和原生 Linux 上一致。
4. 经 `\\wsl.localhost` 的「用…打开」，各编辑器的表现（VS Code 会提示改用 Remote - WSL 打开）。

## 测试

GitHub 的 `windows-2022` 运行器上可以导入一个校验过哈希的 Ubuntu rootfs 来跑端到端测试（Orca 的 `.github/actions/setup-wsl-test-runtime`）。那上面是 WSL 1，网络行为和 WSL 2 不同，上面「待验证」的前两条仍要真机。

## 参考

- T3 Code：`apps/desktop/src/wsl/`、`apps/desktop/src/backend/DesktopBackendConfiguration.ts`
- Zed：`crates/remote/src/transport/wsl.rs`
- Orca：`src/main/wsl/wsl-runner.ts`、`docs/reference/wsl-command-execution.md`
- Multica：`apps/desktop/src/main/daemon-os.ts`
- [Claude Code Desktop in WSL](https://code.claude.com/docs/en/desktop-wsl.md)
