# dsh-shared-terminal

**把侧边栏终端变成人机共享终端的 DSH 插件**：你在 Web 右侧栏开终端、手动登录跳板机；agent 用三个工具列出、输入、读取**同一个会话**——无需 tmux，无需把密码交给 AI。

## 它解决什么问题

DSH 内置的两套终端互不相通：

| | 人（侧边栏） | Agent（terminal_open） |
|---|---|---|
| 服务 | `api-terminal-controller`（`terminalController`） | `dsh-terminal`（`ctx.terminals`） |
| 隔离 | 按 Session | 按 Agent 对象同一性 |
| UI | xterm.js 标签页 | 无 |

本插件在**不新增 UI、不新增 PTY** 的前提下，把 agent 工具桥接到 controller 拥有的终端上。

## 三个工具

| 工具 | 作用 |
|---|---|
| `shared_terminal_list` | 列出本 Session 的侧边栏终端（id、标题、shell、目录、尺寸、状态） |
| `shared_terminal_send` | 向指定终端输入文本（默认回车提交；可 `submit:false` 分段输入）；可等待 shell 空闲后返回当前屏幕 |
| `shared_terminal_read` | 读取终端当前屏幕（与 UI 显示完全一致），**不抢输入权** |
| `shared_terminal_rename` | 给终端命名（1–120 字符），标签标题实时更新 |

**按名字引用**：`send`/`read`/`rename` 的 `id` 参数既接受终端 id，也接受**精确 title**——在侧边栏双击标签改名，或让 agent 调 `shared_terminal_rename`；之后直接说「操作 jump-host 终端」即可。title 重名歧义时报错并列出候选 id。

## 工作方式（安全设计）

- **写入**：走 controller 挂载的 PTY 进程句柄 `write()`，并经由 controller 自己的操作队列 `enqueue` 串行化——与你侧边栏 attach 上行的写入路径完全同序。你在侧边栏能**实时看到 agent 敲的每个字符**（PTY 回显）。
- **读取**：渲染 controller 内部的 headless 屏幕模型（与 UI 渲染同源），**不经过 `attach`**——attach 是排他输入权，会把你的输入权抢走。
- **等待**：`inspectActivity()` 探测 shell 是否回到空闲（bash 后端在 spawn 时开启了 shell activity；远端 SSH 会话可能报 `unknown`，此时等待窗口耗尽后直接返回屏幕）。
- **边界**：controller 按 Session 限定（只能看到本会话的终端）；closed/failed 终端会明确报错；输入字节上限沿用 controller 配置（默认 64 KiB）。

## 典型流程（跳板机）

1. 你：侧边栏「新建终端」→ `ssh jump` → 手动输密码/OTP
2. 你：对话里说「接管侧边栏终端」
3. Agent：`shared_terminal_list` 拿到 id → `shared_terminal_send` 操作 → `shared_terminal_read` 读结果
4. 全程你在侧边栏围观；密码只经过你的手

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxResultBytes` | 262144 | 单次工具结果字节上限 |
| `sendWaitMs` | 3000 | 提交后等待 shell 空闲的默认窗口（0–20000ms，可用 `waitMs` 参数按次覆盖） |

## 依赖与挂载

- 依赖 web app bundle 默认提供的 `terminalController` 服务（`@deepseek-ai/dsh-web-app` 的 `terminal-controller` 条目），缺它会 fail-loud。
- bundle patch 只插入一行 `shared-terminal`，注册进全局工具层。

## 限制

- 终端进程仍是 controller 资产：侧边栏标签关闭即结束进程；无人附着 2 小时后按 controller 的空闲回收策略清理（`unattendedTimeoutMs` 默认 72e5 ms）。
- Agent 写入与你的键盘输入共享同一个 PTY——二者同时打字会交错（就像两个人共用一块键盘），这是共享语义的一部分。
- 不提供 close/signal 工具：关标签、Ctrl-C 请用 UI 或让 agent 发 `\x03`。
