# AI Usage Meter

给 **Claude Code** 和 **Codex** 的每一个对话显示它自己用了多少：Token 按缓存命中、写入缓存、未命中、输出拆开，按官方 API 价格算出等价费用，再估算它占了订阅 5 小时 / 每周额度的多少、按订阅价值多少钱。

*Per-chat usage meters for Claude Code and Codex: token breakdown (cache read / cache write / uncached input / output), API-equivalent cost, share of the 5-hour and weekly subscription allowance, and its value at your subscription price. English summary at the end.*

所有数据都从本机的会话记录里读，不上传任何东西。算法、文件和接口以 [ARCHITECTURE.md](ARCHITECTURE.md) 为准；价格数字以代码里的 `PRICES` 为准。

## Claude Code 插件：`claude-usage-meter`

**输入框上方的一条**（默认收起成一行，点「展开」看完整三行）。有子智能体时，展开后的标题会写成「本会话累计 · 含 N 个子智能体」：

```
本会话 $13.80 · 占每周 4.2% · 账号剩余 5 小时 93.0% · 每周 18.0%            [展开]

本会话累计 · 账号剩余 5 小时 93.0% · 每周 18.0%                             [收起]
占 5 小时额度 32.3%   占每周额度 4.2%   按周额度折算 ¥1.47   累计 Token 3441.1万
缓存命中 3369.1万   写入缓存 61.1万   未命中 308   输出 10.9万   命中率 98.2%
按 API 价格 $13.80 ≈ ¥93.86   缓存命中 $6.74   写入缓存 $4.89   未命中 $0.00   输出 $2.18
```

**`/usage-meter`** 打开侧边面板，列出所有会话各自的 Token、API 费用和占每周额度，以及「一周额度用满约值多少美元」。读不到会话目录时，这里会写出失败原因，而不是一直停在「正在读取」。

### 安装

在终端里的 Claude Code：

```
/plugin install claude-usage-meter --marketplace divineyl/ai-usage-meter
```

或者命令行：

```bash
claude plugin marketplace add divineyl/ai-usage-meter
claude plugin install claude-usage-meter@ai-usage-meter
```

桌面版：点输入框旁的 **+** → Plugins → Add marketplace，填 `divineyl/ai-usage-meter` → 找到 claude-usage-meter → Add plugin。

插件会用 PATH 里的 `node` 运行 `scan.cjs`。这个扫描脚本只用文件系统，不需要 SQLite。本仓库的测试和下面的 Codex 补丁需要 **Node.js 22.5 或更新**（`node:sqlite`）。

### 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `monthlyPrice` | 140 | 订阅月费。不是正数时退回 140 |
| `weeksPerMonth` | 4 | 每周额度价值 = 月费 ÷ 这个数。不是正数时退回 4 |
| `currency` | CNY | 大小写不敏感。只有 `USD` 用美元，其他任何值都当 `CNY` |
| `usdToCny` | 6.8 | API 价格是美元，显示人民币时的汇率。不是正数时退回 6.8 |

在 `/plugin` 的配置菜单里改，或写进 `settings.json` 的 `pluginConfigs["claude-usage-meter"]`。

### 怎么算的

- **会话记录**：`CLAUDE_CONFIG_DIR/projects`，没设置这个环境变量时是 `~/.claude/projects`。每个会话读 `会话id.jsonl`，再加上 `会话id/subagents/*.jsonl`。同一条回复会按内容块重复出现，用 `message.id` 去重（没有 id 时用 `requestId`，再没有用 `uuid`），**同一个 id 以最后一条为准**。模型名是 `<synthetic>` 的记录整条跳过。
- **Token 和 API 费用**：每次请求按它自己的模型计价，单位是美元 / 百万 Token，五项依次为：输入、5 分钟缓存写入、1 小时缓存写入、缓存命中、输出。有 `cache_creation` 时，5 分钟和 1 小时写入分开计价；没有这个对象时，旧字段 `cache_creation_input_tokens` 全部按 5 分钟写入计价。界面上的「写入缓存」Token 数是两者之和，钱仍然分开算。完整单价表在 [ARCHITECTURE.md](ARCHITECTURE.md)，源码在 [`scan.cjs`](plugins/claude-usage-meter/scan.cjs) 的 `PRICES`。模型 id 后面带日期（`-` 或 `@`）时，用表里能对上的前缀。
- **加价**：Haiku 5.5 在「输入 + 缓存命中 + 两段缓存写入」**超过** 10 万 Token 时，这一次请求整段 ×5。`usage.speed` 为 `fast` 时再 ×2，任何模型都适用，和 Haiku 的 ×5 叠乘。不在价格表里的模型：Token 照算，美元不算（`unpriced` 加一，界面不单列这个数）。
- **命中率**：缓存命中 ÷（缓存命中 + 写入缓存 + 未命中），不含输出。
- **账号额度**：读 Claude Code 已经拿到的 `five_hour` 和 `seven_day` 已用百分比和重置时间。界面上的「剩余」是 `100% − 已用`。
- **窗口**：周窗口从「每周重置时间减 7 天」算起，5 小时窗口从「重置时间减 5 小时」算起。重置时间解析不了时，当作没有这个窗口。窗口内、并且有标价的回复，加总成 `weekUsd` / `fiveUsd`。
- **单个会话占多少额度**：Claude 没有「每个会话占多少额度」的官方数据，所以是估算：`会话累计 API 美元 × 账号该窗口已用百分比 ÷ 本机所有会话在该窗口内的 API 美元`。这里用的是会话**从开头累计**的费用，不是只算落在当前窗口里的那一段。账号该窗口已用不足 1%、窗口内美元缺失或不是正数时，占比显示「—」。占比可以超过 100%。网页版和手机 App 的用量算进了账号百分比，但不在本机记录里，会把本机会话的占比估高。
- **按周额度折算**：`占比 ÷ 100 × (月费 ÷ weeksPerMonth)`，币种跟 `currency` 走。

## Codex：给 Codex Usage Badge 加上每个对话的用量

在 [Codex Usage Badge](https://github.com/jaykinhoo9/codex-usage-badge)（Windows 版 0.10.1）的基础上：

- 左侧栏每个对话旁边直接显示累计 Token 数（原来是要悬停才看得到的色块），悬停显示完整拆分；
- 对话顶部一栏：这个对话占 5 小时额度、占每周额度、已用额度（来自 Codex 自己的每对话用量接口，和设置里的「聊天用量排行」同源），累计 Token，缓存命中输入 / 未命中输入 / 输出，缓存命中率，**按 API 价格**的费用，以及**按周额度折算**的钱；
- 原来左下角的账号 5 小时 / 每周剩余额度保留。

Token 拆分取这份对话记录里**最后一条有效的累计计数**（推理 Token 已经含在输出里，不另加）。API 费用则是把每次请求的增量按当时的模型分开计价，含子智能体：

| 模型 | 输入 | 缓存命中 | 输出 |
|---|---|---|---|
| GPT-6.1 Sol | $2 | $0.10 | $10 |
| GPT-6 Astra | $10 | $1 | $50 |
| GPT-6.1 Terra | $1 | $0.05 | $5 |
| GPT-6 Luna | $0.10 | $0.01 | $0.50 |

单位是美元 / 百万 Token，必须和记录里的模型 id 完全一致。缓存写入按输入价的 **1.25 倍**，并且不超过这次未命中的输入；界面不单列写入 Token。单次输入**大于** 272K 时，整段输入（含缓存命中和缓存写入）×2，输出 ×1.5。模型不在表里时，这一份记录的 API 费用整段不算，显示「—」，不会当成 0 美元。父对话或任一子智能体算不出价格时，整个对话的 API 费用都是「—」。

5 小时 / 每周占比和已用额度不是估算。按周额度折算 = 官方每周占比 ×（月费 ÷ 每周数），币种跟配置走。

### 安装

1. 先装好 Codex Usage Badge 并确认它在工作。
2. 需要 Node.js 22.5 或更新（读 Codex 的 SQLite 用内置的 `node:sqlite`）。
3. 在 PowerShell 里：

```bash
git clone https://github.com/divineyl/ai-usage-meter
node ai-usage-meter/codex/apply.cjs
```

它会把 Codex Usage Badge 原来的 `agent.cjs`、`bridge.cjs` 备份成 `*.before-per-chat.bak`，打上补丁，**关闭它的自动更新**（否则更新会覆盖补丁），然后重新加载。卸载：

```bash
node ai-usage-meter/codex/apply.cjs --uninstall
```

会还原原文件并重新打开自动更新。设置文件会留下。

补丁认的是 0.10.1 里的代码位置，不读取版本号。对不上时会报错，并且**不改任何文件、也不写备份**。安装目录不是默认位置时：

```bash
node codex/apply.cjs --dir C:\path\to\CodexUsageBadge --no-reload
```

`--no-reload` 只改文件，不调用 PowerShell。不带它时必须在 Windows 上跑，因为重新加载要用安装目录里的 `manage-windows.ps1`。

### 设置

默认是 `%LOCALAPPDATA%\CodexUsageBadge\per-chat-usage.config.json`。用了 `--dir` 时，文件在那个目录里，和补丁写进去的脚本放在一起。字段和 Claude 插件一样（`monthlyPrice`、`weeksPerMonth`、`currency`、`usdToCny`）。`currency` 只认 `CNY` 和 `USD`（大小写都行）。不是正数的金额、周数、汇率会被忽略并退回默认值。文件不是合法 JSON 时，用默认值，并在运行补丁的进程里打出错误。改完后下一次刷新生效。

### 注意

- 每对话额度接口和 Codex 前端代码里的函数名都不是公开 API，Codex 更新后可能失效。失效时对话顶部会说明额度暂时不可用，并在悬停说明里带上原因；Token 和 API 费用照常（它们来自本机的会话文件，不走那个接口）。
- 只在 Codex Usage Badge 0.10.1 上按代码锚点测试过。

## 开发

需要 Node.js 22.5 或更新。没有要安装的依赖。

```bash
npm test
```

`npm run codex:apply` 和 `npm run codex:uninstall` 就是上面的补丁命令。环境变量：`CLAUDE_CONFIG_DIR`、`USAGE_METER_CACHE`、`CODEX_HOME`、`LOCALAPPDATA`。各自做什么见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## English summary

- **Claude Code plugin** (`plugins/claude-usage-meter`): a collapsible strip above the prompt with this session's tokens by category, API-equivalent cost per category, estimated share of the 5-hour / weekly allowance, and that share's value at your subscription price. `/usage-meter` lists every session and shows a scan error instead of spinning forever. Install with `/plugin install claude-usage-meter --marketplace divineyl/ai-usage-meter`. Settings: `monthlyPrice`, `weeksPerMonth`, `currency` (`CNY`/`USD`, any other value is CNY), `usdToCny`. Non-positive numbers fall back to the defaults.
- **How Claude math works**: transcripts under `CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, subagents included, last duplicate message id wins. Haiku 5.5 costs 5× when input + cache read + cache writes exceed 100K tokens; `usage.speed === "fast"` doubles any model, and the two multipliers stack. The session's quota share is `lifetime API $ × account percent used ÷ API $ of all local sessions inside that window`. It is hidden below 1% account usage. It uses lifetime session cost, not the in-window subset. Web and mobile usage makes the estimate high. Price table: [ARCHITECTURE.md](ARCHITECTURE.md).
- **Codex** (`codex/`): a patch for [Codex Usage Badge](https://github.com/jaykinhoo9/codex-usage-badge) 0.10.1 on Windows. The sidebar shows each chat's tokens; the header shows official per-chat quota shares, the latest cumulative token breakdown, API-equivalent cost, and subscription value in the configured currency. Cache writes are priced at 1.25× input and are not a separate token cell. Prompts over 272K tokens cost 2× on the whole input side and 1.5× on output. An unknown model blanks that rollout's API cost. `node codex/apply.cjs` applies the patch, `--uninstall` reverts it, `--dir` and `--no-reload` select the folder and skip PowerShell. A layout that is not 0.10.1 fails before any file is written.
- Everything is read from local session files; nothing is sent anywhere except the Codex header's quota percentages, which Codex itself already requests.

MIT License. The Codex patch builds on Codex Usage Badge (MIT).
