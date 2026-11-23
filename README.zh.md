# dsh-shared-terminal

[English](README.md) | [中文](README.zh.md)

一个 DeepSeek Harness（DSH）bundle：把 **Web 侧边栏终端变成人机共享终端**——你在右侧栏开终端，亲手输入必须由你掌握的内容（SSH 密码、一次性验证码）；agent 用工具列出、输入、读取**同一个会话**，你在自己的标签页里实时围观它的每一次敲键。

无需 tmux 桥接，密码不经模型，零新增 UI，零新增 PTY。

## 解决什么问题

DSH 内置两套互不相通的终端：

| | 人（侧边栏） | Agent（`terminal_open`） |
|---|---|---|
| 服务 | `api-terminal-controller`（`terminalController`） | `dsh-terminal`（`ctx.terminals`） |
| 隔离 | 按 Session | 按 Agent 对象同一性 |
| UI | xterm.js 标签页 | 无 |

本 bundle 把 agent 工具桥接到 controller 拥有的终端上——人的标签页仍是唯一显示，交互式认证始终是人这一步。

## 工具

| 工具 | 作用 |
|---|---|
| `shared_terminal_list` | 列出本 Session 的侧边栏终端（id、标题、shell、目录、尺寸、状态） |
| `shared_terminal_send` | 向终端输入文本（默认回车提交；`submit: false` 用于密码提示前的分段输入）；可等待 shell 空闲并返回当前屏幕 |
| `shared_terminal_read` | 读取终端当前屏幕——与人所见完全一致；**绝不抢输入权** |
| `shared_terminal_rename` | 给终端命名（1–120 字符），侧边栏标签标题实时更新 |

**按名字引用**：所有工具的 `id` 参数既接受终端 id，也接受**精确 title**。在侧边栏双击标签改名，或让 agent 调 `shared_terminal_rename`；之后直接说「操作 jump-host 终端」。title 重名歧义时会报错并列出候选 id。

## 安装

适用于任何已在运行 DSH Web profile 的机器。需要 Node 20+（或你的 `dsh` 运行时所用版本）、pnpm、PATH 上的 `dsh`。

### 把这段话交给你的 agent

> 把 https://github.com/FomoGoMan/dsh-shared-terminal 安装到我的 `<profile>` profile：克隆、构建、以 link 依赖装入、验证 bundle 注册成功，然后提醒我重启 dsh。

agent 应执行：

```bash
git clone https://github.com/FomoGoMan/dsh-shared-terminal.git
cd dsh-shared-terminal
pnpm install
pnpm build
dsh plugin --profile <your-profile> add link:"$PWD"
dsh --profile <your-profile> --dump-config | grep shared-terminal   # 组合校验
```

然后**重启 dsh**（harness 在启动时装载 bundle；重启也会关掉已打开的侧边栏终端进程）：

```bash
kill $(lsof -ti :3082)   # 停掉 web 实例（端口或启动方式不同请自行调整）
dsh --profile <your-profile> --no-open   # 按你平时的方式启动
```

### 手动安装

命令同上，手动执行即可。`<your-profile>` 是你的 Web UI 运行所在 profile——可用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 找到运行中的实例查看其打开的文件确认，或直接用你启动 `dsh web` 的那个 profile。

### 验证

1. `dsh --profile <your-profile> --dump-config | grep shared-terminal` — 组合树中包含 `- id: shared-terminal`。
2. 重启后让 agent「列出共享终端」— 它应调用 `shared_terminal_list` 并返回你的侧边栏终端。
3. 在侧边栏开一个终端，让 agent 向它输入 `echo hello from the agent` — 你会实时看到内容出现。

### 故障排查

- **`shared-terminal: the terminalController service is required`** — profile 缺少 Web 应用的终端 controller。把 `@deepseek-ai/dsh-web-app` 加进 profile 的 bundles（任何 Web profile 默认都有）。
- **安装被版本兼容性检查拒绝** — 本 bundle 针对 dsh `0.2.1-rc.3`（见 `peerDependencies`）。先 `dsh --version` 对齐运行时版本：克隆匹配你版本的 tag，或按 dsh 提示授予豁免（风险自担）。
- **重启后工具缺失** — 确认 profile `package.json` 的 `dsh.profile.bundles` 含本 bundle，且克隆目录里存在 `lib/index.js`（在克隆内执行 `pnpm build`）。

## 使用——跳板机工作流

1. **你**：侧边栏「新建终端」→ `ssh jump` → 亲手输密码/OTP。
2. **你**：告诉 agent「接管我的侧边栏终端」（可以先说「把它命名为 jump-host」）。
3. **Agent**：`shared_terminal_list` → `shared_terminal_read` 看你登到哪了 → `shared_terminal_send` 执行命令 → `shared_terminal_read` 读结果。
4. agent 敲的每个字符都实时出现在你的标签页里；你的凭据不会进入对话。

## 设计说明

- **写入**走终端进程句柄 `write()`，并在 controller 自己的操作队列内执行——与侧边栏 attach 上行的写入路径完全同序——输入与屏幕状态与你的手工操作保持串行化，同时以同样方式重置 retention 空闲时钟（无人附着回收器不会关掉 agent 正在驱动的终端）。
- **读取**渲染 controller 内部的 headless 屏幕模型——与 UI 所见同源——刻意**不经 `attach`**：attach 持有排他输入权，会抢走你正在进行的输入会话。
- **边界**：controller 只暴露本 Session 的终端；closed/failed 终端明确报错；输入字节上限沿用 controller 配置（默认 64 KiB）。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxResultBytes` | 262144 | 单次工具结果 UTF-8 上限 |
| `sendWaitMs` | 3000 | 提交后等待空闲的默认窗口（0–20000 ms；可用 `waitMs` 按次覆盖） |

## 限制

- 终端进程仍是 controller 资产：关闭侧边栏标签即结束进程；无人附着的空闲终端在 `unattendedTimeoutMs`（默认 2 小时）后被回收器关闭。
- agent 键入与人的键入共享同一个 PTY——同时打字会交错，就像两个人共用一块键盘。这正是共享语义。
- 不提供 close/signal 工具：在 UI 里关标签，或让 agent 以文本发送 `\x03`（Ctrl-C）。
- 空闲探测读取 shell 活动标记；自定义提示符（如美化的 zsh）可能报 `unknown`，此时 send 的等待窗口自然耗尽并原样返回屏幕。

## 开发

```bash
pnpm install
pnpm build
node --experimental-strip-types tests/smoke.ts   # 契约与行为冒烟测试
```

针对 dsh `0.2.1-rc.3` 构建；宿主服务在运行时从 harness 解析（`neverBundle: /^@deepseek-ai\//`）。

## 许可

MIT
