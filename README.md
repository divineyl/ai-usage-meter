# AI Usage Meter

给 **Claude Code** 和 **Codex** 的每一个对话显示它自己用了多少：Token 按缓存命中、写入缓存、未命中、输出拆开，按官方 API 价格算出等价费用，再估算它占了订阅 5 小时 / 每周额度的多少、按订阅价值多少钱。

*Per-chat usage meters for Claude Code and Codex: token breakdown (cache read / cache write / uncached input / output), API-equivalent cost, share of the 5-hour and weekly subscription allowance, and its value at your subscription price. English summary at the end.*

所有数据都从本机的会话记录里读，不上传任何东西。

## Claude Code 插件：`claude-usage-meter`

**输入框上方的一条**（默认收起成一行，点"展开"看完整三行）：

```
本会话 $13.80 · 占每周 4.2% · 账号剩余 5 小时 93.0% · 每周 18.0%            [展开]

本会话累计 · 账号剩余 5 小时 93.0% · 每周 18.0%                             [收起]
占 5 小时额度 32.3%   占每周额度 4.2%   按周额度折算 ¥1.47   累计 Token 3441.1万
缓存命中 3369.1万   写入缓存 61.1万   未命中 308   输出 10.9万   命中率 98.2%
按 API 价格 $13.80 ≈ ¥93.86   缓存命中 $6.74   写入缓存 $4.89   未命中 $0.00   输出 $2.18
```

**`/usage-meter`** 打开侧边面板，列出所有会话各自的 Token、API 费用和占每周额度，以及"一周额度用满约值多少美元"。

### 安装

在终端里的 Claude Code：

```
/plugin install claude-usage-meter --marketplace divineyl/ai-usage-meter
```

或者命令行：

```bash
claude plugin marketplace add divineyl/ai-usage-meter
```

```bash
claude plugin install claude-usage-meter@ai-usage-meter
```

桌面版：点输入框旁的 **+** → Plugins → Add marketplace，填 `divineyl/ai-usage-meter` → 找到 claude-usage-meter → Add plugin。

需要本机装有 Node.js（插件用它读会话记录）。

### 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `monthlyPrice` | 140 | 订阅月费 |
| `weeksPerMonth` | 4 | 每周额度价值 = 月费 ÷ 这个数 |
| `currency` | CNY | `CNY` 或 `USD`：月费和折算结果的币种 |
| `usdToCny` | 6.8 | API 价格是美元，显示人民币时的汇率 |

在 `/plugin` 的配置菜单里改，或写进 `settings.json` 的 `pluginConfigs["claude-usage-meter"]`。

### 怎么算的

- **Token 和 API 费用**：逐条读 `~/.claude/projects` 下这个会话和它的子智能体的记录（同一个回复按 message id 去重），每次请求按它的模型单独计价：Opus 5.5 输入 $4、5 分钟缓存写入 $5、1 小时缓存写入 $8、缓存命中 $0.20、输出 $20（每百万 Token），Sonnet 5.5 缓存命中 $0.10，Haiku 5.5 超过 10 万的输入 ×5，fast 模式 ×2。完整价格表在 [`scan.cjs`](plugins/claude-usage-meter/scan.cjs)，对照 2026-11-11 的 [Anthropic 定价](https://platform.claude.com/docs/en/about-claude/pricing)。
- **账号额度**：直接读 Claude Code 自己拿到的 5 小时 / 每周用量和重置时间。
- **单个会话占多少额度**：Claude 没有"每个会话占多少额度"的官方数据，所以是估算：本周期里所有会话按 API 价格一共花了 X 美元、账号额度用了 Y%，于是每 1% ≈ X/Y 美元，再用这个会话自己的费用折算。网页版和手机 App 的用量也占同一份额度但不在本机记录里，会让估算偏高。

## Codex：给 Codex Usage Badge 加上每个对话的用量

在 [Codex Usage Badge](https://github.com/jaykinhoo9/codex-usage-badge)（Windows 版 0.10.1）的基础上：

- 左侧栏每个对话旁边直接显示累计 Token 数（原来是要悬停才看得到的色块），悬停显示完整拆分；
- 对话顶部一栏：这个对话占 5 小时额度、占每周额度、已用额度（来自 Codex 官方的每对话用量接口，和设置里的"聊天用量排行"同源），累计 Token，缓存命中 / 未命中 / 输出，缓存命中率，**按 API 价格**的费用，以及**按周额度折算**的钱；
- 原来左下角的账号 5 小时 / 每周剩余额度保留。

API 费用逐个请求计算：用该请求所用模型的 OpenAI 标价（GPT-6.1 Sol 输入 $2 / 缓存 $0.10 / 输出 $10，GPT-6 Sol 缓存是 $0.20，GPT-6 Astra $10 / $1 / $50，GPT-6.1 Terra $1 / $0.05 / $5，GPT-6 Luna $0.10 / $0.01 / $0.50，另有 GPT-5.6 和更早的文本模型）。GPT-5.6 及以后的缓存写入，记录里没有分开时按 30 分钟档（输入 ×1.25）；分开标了 12 小时时按输入 ×2.5。单次输入超过 272K、且该模型有长上下文档时，按长上下文价（输入 ×2、输出 ×1.5），含子智能体。价格对照 2026-11-11 的 [OpenAI 定价](https://developers.openai.com/api/docs/pricing)。

### 安装

1. 先装好 Codex Usage Badge 并确认它在工作。
2. 需要 Node.js 22.5 或更新（读 Codex 的 SQLite 数据库用）。
3. 在 PowerShell 里：

```bash
git clone https://github.com/divineyl/ai-usage-meter
```

```bash
node ai-usage-meter/codex/apply.cjs
```

它会把 Codex Usage Badge 原来的 `agent.cjs`、`bridge.cjs` 备份成 `*.before-per-chat.bak`，打上补丁，**关闭它的自动更新**（否则更新会覆盖补丁），然后重新加载。卸载：

```bash
node ai-usage-meter/codex/apply.cjs --uninstall
```

会还原原文件并重新打开自动更新。

### 设置

`%LOCALAPPDATA%\CodexUsageBadge\per-chat-usage.config.json`，字段和 Claude 插件的一样（`monthlyPrice`、`weeksPerMonth`、`currency`、`usdToCny`），改完下一次刷新生效。

### 注意

- 每对话额度接口和 Codex 前端代码里的函数名都不是公开 API，Codex 更新后可能失效。失效时对话顶部的额度显示"—"，Token 和 API 费用照常。
- 只在 Codex Usage Badge 0.10.1 上测试过；版本不对时 `apply.cjs` 会报错并且不改任何文件。

## 开发

```bash
npm test
```

## English summary

- **Claude Code plugin** (`plugins/claude-usage-meter`): a collapsible strip above the prompt with this session's tokens by category, API-equivalent cost per category, estimated share of the 5-hour / weekly allowance and its value at your subscription price; `/usage-meter` lists every session. Install with `/plugin install claude-usage-meter --marketplace divineyl/ai-usage-meter`. Settings: `monthlyPrice`, `weeksPerMonth`, `currency` (`CNY`/`USD`), `usdToCny`.
- **Codex** (`codex/`): a patch for [Codex Usage Badge](https://github.com/jaykinhoo9/codex-usage-badge) 0.10.1 on Windows that shows each chat's tokens in the sidebar and a per-chat header with official per-chat quota shares, token breakdown, API-equivalent cost and subscription value. `node codex/apply.cjs` to apply, `--uninstall` to revert.
- Everything is read from local session files; nothing is sent anywhere. The per-session quota share for Claude is an estimate (API dollars spent this window ÷ percent of the window used).

MIT License. The Codex patch builds on Codex Usage Badge (MIT).
