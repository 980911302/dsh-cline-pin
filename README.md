# dsh-cline-pin

把 [Cline Pass](https://cline.bot/cline-pass) 订阅模型接入 DeepSeek Harness（dsh，即 DeepSeek 桌面版），并且能**钉住每个模型背后的上游渠道**。

Cline Pass 的一个模型背后通常有好几个上游渠道（比如 `baseten`、`alibaba`），网关默认自己挑。这个插件让你指定：这个模型只走哪几个渠道、不许走哪些、第一个渠道挂了换哪个，并且每次请求都会**核对网关到底有没有照做**。

只做这一件事，没有账号池、面板、管理工具：`lib/` 约 1100 行（含注释），对比功能完整的 dsh-cline-pass 的 `lib/` 约 7300 行。

## 安装（DeepSeek 桌面版）

先把整个 `dsh-cline-pin` 文件夹放到一个固定位置（用下面的 `link` 方式安装时，文件夹挪走插件就失效了）。然后用桌面版自带的 `dsh` 命令安装到 `desktop` profile：

```bash
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add /你放的路径/dsh-cline-pin
```

> App 如果不在 `/Applications`（比如装在外置盘），把前面那段换成你机器上的实际路径。
> 想要安装后和源码文件夹脱钩：先在文件夹里执行 `npm pack`，再把上面命令里的路径换成生成的 `.tgz` 文件。

装完重启 DeepSeek 桌面版。卸载：把 `add` 换成 `remove dsh-cline-pin`，再删掉你补丁里 `cline-pin` 那几行。

## 配置密钥

插件只认凭据名（默认 `CLINE_PASS_API_KEY`），密钥本身不写进任何配置。桌面版通常从 Finder/Dock 启动，**读不到你终端里 `export` 的变量**，请用 dsh 的凭据存储，二选一：

- 在 `~/.dsh/.env` 里加一行：`CLINE_PASS_API_KEY=sk-...`
- 或在 `~/.dsh/.credentials.yaml` 的 `refs:` 下加 `CLINE_PASS_API_KEY: sk-...`（文件必须只有你自己能读：`chmod 600`）

查找顺序是：启动环境变量 → `.credentials.yaml` → 项目 `.env` → `~/.dsh/.env`（出自 dsh 凭据存储的文档）。`.credentials.yaml` 改完会自动重新加载；改 `.env` 后请重启 App。

## 配置钉住

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，加上（已经有 `cline-pin` 那一行就改它，不要重复）：

```yaml
- id: cline-pin
  name: dsh-cline-pin
  config:
    perModel:
      cline-pass/kimi-k3:
        upstreams: [baseten, alibaba]   # 候选渠道，按优先级
        pinMode: strict                 # strict：一次请求只许一个渠道；preferred：优先，但允许回退
        exclude: [deepseek]             # 永远不许用的渠道
        sort: ttft                      # 可选：cost / ttft / tps
```

> dsh 的补丁会**整体替换**同 id 那一行的 `config`，所以这一行里想要的配置都写全。

然后在 App 里选模型时，选 provider **Cline Pass (Pin)**。想让它做默认模型，把已有的 `agent-default-model` 那一行改成：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: cline-pin
    model: cline-pass/kimi-k3
```

### 两种模式

| `pinMode` | 每次请求发给网关的约束 | 第一个渠道失败时 |
|---|---|---|
| `strict`（默认） | `only: [当前渠道]`，网关这次只能用它 | 插件在首个内容块之前换名单里的下一个渠道重发 |
| `preferred` | `order: [当前渠道, ...其余]`，只是优先 | 网关自己按顺序回退；插件也会换下一个渠道 |

`exclude` 在两种模式下都生效。没写 `upstreams` 时是"自动路由，但不许走 `exclude` 里的渠道"。

### 全部选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `perModel` | `{}` | 上面的钉住配置，按模型 id 分别写 |
| `enforce` | `false` | 开启后，网关没遵守钉住（换了别的渠道）就在交出任何内容之前放弃这次尝试，换下一个候选；全部候选都不行就报错 `PIN_NOT_HONORED` |
| `knownModels` | 内置 15 个，设置页可刷新 | 在模型列表里出现的模型 id |
| `models` | `{}` | 单个模型的覆盖：`name`、`contextWindow`、`maxTokens`、`reasoning`、`defaultReasoningEffort` |
| `reasoningModels` | `true` | 为已知推理模型提供思考强度选择；可用单个模型的 `reasoning` 覆盖 |
| `defaultContextWindow` | `128000` | 没单独指定时的上下文窗口（官方标明 1M 的 4 个模型已内置） |
| `defaultMaxTokens` | `32000` | 单次回答的输出上限 |
| `logFile` | `''` | 请求日志；空 = `~/.dsh/logs/cline-pin.log`，`off` = 不写，也可写具体路径 |
| `baseURL` | `https://api.cline.bot/api/v1` | 网关地址 |
| `apiKeyEnv` | `CLINE_PASS_API_KEY` | 密钥的凭据名 |
| `streamIdleTimeoutMs` | `300000` | 流式响应多久没数据就算超时 |
| `provider` / `displayName` | `cline-pin` / `Cline Pass (Pin)` | provider 路由名与显示名 |

### 思考模式与强度

在聊天输入框底部点击模型名称，再打开「推理等级」。DeepSeek V4.1 Flash（包括 1017）和 V4 Pro 提供 **Off / Low / High / Max**，默认 **High**。Off 会显式关闭思考；Max 会按最高强度发送，不再降为 High。切换后从下一次请求生效。

DeepSeek 的实际档位见[官方思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)；已有配置中的 `medium` / `xhigh` 按 High 处理，`minimal` 按 Low，`ultra` 按 Max。

要覆盖默认强度，在 profile 的 `cordis.patch.yml` 中添加（已有 `cline-pin` 条目时合并到其完整配置）：

```yaml
- id: cline-pin
  name: dsh-cline-pin
  config:
    models:
      cline-pass/deepseek-v4.1-flash-1017:
        reasoning: true
        defaultReasoningEffort: high
```

## 怎么知道渠道叫什么

用自带的命令行工具（只需要 Node，不用启动 dsh）。密钥只通过环境变量传，**不要写在命令行参数里**：

```bash
export CLINE_PASS_API_KEY=sk-...
node bin/cline-pin.mjs models                              # 官方当前的订阅模型，输出可直接粘贴的 knownModels
node bin/cline-pin.mjs probe cline-pass/kimi-k3            # 列出这个模型背后的渠道（不消耗 token）
node bin/cline-pin.mjs check cline-pass/kimi-k3            # 逐个渠道发一次极小的真实请求，核对是不是真由它响应
node bin/cline-pin.mjs check cline-pass/kimi-k3 baseten    # 只检查指定的渠道
```

`probe` 的原理：把渠道钉到一个不存在的名字，路由器会在花任何 token 之前报错，并把它能用的渠道全列出来。Cline 的网关背后有两套路由器（OpenRouter 和 Vercel AI Gateway），每次调用走哪套由网关决定，所以会分别列出两份；同一个渠道在两边的拼法偶尔不同（`zai` / `z-ai`），插件会自动按各自的拼法写。

## 怎么确认钉住生效了

每个请求会在 `~/.dsh/logs/cline-pin.log` 记一行，用 `tail -f` 看：

```
ts=2026-10-15T13:50:03.123Z model=cline-pass/kimi-k3 want=baseten got=Baseten verdict=adopted ms=812
ts=2026-10-15T13:51:10.456Z model=cline-pass/kimi-k3 want=baseten result=failed code=SERVER next=alibaba error="upstream baseten unavailable"
ts=2026-10-15T13:51:11.002Z model=cline-pass/kimi-k3 want=alibaba got=Alibaba verdict=adopted ms=640 earlier_failures=baseten
```

`verdict` 的含义：

| verdict | 含义 |
|---|---|
| `adopted` | 实际响应的渠道就是钉住的渠道 |
| `fallback` | 落在 `preferred` 名单里的后备渠道，算合法 |
| `missed` | **网关无视了钉住**，换了别家 |
| `violated` | 被 `exclude` 排除的渠道响应了请求 |
| `auto` | 这个模型没钉渠道，无从比较 |
| `unknown` | 响应里没标明渠道，无法判断 |

日志里只有模型名、渠道名、耗时和错误码，没有对话内容和密钥。超过 2MB 会在下次启动时轮转成 `.log.1`。

## 工作原理

1. **写进请求**：把约束同时写成两种拼法——顶层 `provider.only/order/ignore/sort`（OpenRouter）和 `providerOptions.gateway.only/order/sort`（Vercel）。每套路由器只认自己那份，所以同时写是安全的。`exclude` 在 Vercel 一侧没有对应字段，只能先用 `probe` 同样的办法取得渠道清单（每个模型只取一次、缓存 1 小时、不花 token），再编译成"已知渠道 − 排除项"的白名单；OpenRouter 一侧另外写一份 `ignore` 兜底。
2. **读回核对**：HTTP 200 并不能证明钉住生效——路由器会悄悄丢掉它认不出的 `only`，再随便挑个渠道。所以从响应里读出实际服务的渠道（OpenRouter 路由是每帧的 `provider`，Vercel 路由是 `provider_metadata.gateway.routing.finalProvider`），和期望比对，结果写进日志。
3. **学习兜底**：如果某个模型的渠道清单暂时探测不到，第一次请求成功后，插件会从响应里读出实际渠道，并按实际服务它的那条路由器拼法记住；后续只在该路由上写约束，不会把渠道名硬塞给另一条可能不认识它的路由器。
4. **失败转移**：一个候选只有在还没有任何内容交给 dsh 时才会被放弃——非 2xx、传输错误、空回答、错误帧、（`enforce` 开启时）钉住没被遵守，都会换下一个候选。账号、额度、上下文这类换渠道也没用的错误会直接上报。内容一旦开始输出，这条流就是答案，之后的失败如实上报，不再重试。

## 已知限制

- **`enforce` 并不总能拦住**：它只能在"交出第一块内容之前"生效，前提是网关在最早的几帧里就带了渠道标记。按 dsh-cline-pass 的观察，OpenRouter 路由每一帧都带 `provider`；Vercel 路由的标记可能要到流的末尾才出现，这时请求已经在输出了，只能事后在日志里记成 `missed`。**没有拿真实的 Cline Pass 密钥验证过**，上面的行为是对着一个本地模拟网关测的，真实网关的细节以你的日志为准。
- **图片输入**：DeepSeek V4.1 Flash（包括 1017）、GLM-5.3 Flash、Kimi K3、MiniMax-M3、Qwen3.8 Max、Qwen3.7 Plus、MiMo-V2.5 声明为支持图片；其它模型仍按纯文本声明，避免把图片块发给不支持的上游。
- **单账号**：没有账号池，也没有并发上限。要这些请用功能更全的 [dsh-cline-pass](https://github.com/yhshzh/dsh-cline-pass)。
- 默认模型清单和上下文窗口取自 2026-10-15 的官方公开清单；之后新增模型用 `cline-pin models` 重新生成 `knownModels`。
- 只在 dsh `0.2.0-rc.2` 上验证过，声明兼容 `>=0.2.0-rc.2 <0.3.0`。

## 测试

```bash
npm test             # 54 个单元测试（纯逻辑 + 本地假网关），不需要 dsh
npm run test:e2e     # 端到端：用你机器上真实的 dsh 加载插件，对本地假网关发请求
```

端到端测试全程使用临时的 `DSH_HOME`，不会碰你真实的 `~/.dsh`，也不联网。它需要找到 `dsh`：设置环境变量 `DSH_BIN`，或把 `dsh` 放进 `PATH`，或装在 `/Applications`。

## 致谢

思路来自 [dsh-cline-pass](https://github.com/yhshzh/dsh-cline-pass) 与它参考的 [cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher)（均为 MIT）。本项目是只保留"钉住渠道"这一件事的精简重写，代码没有复制它们的实现；网关协议上的发现（两种拼法、渠道别名、用不存在的渠道取清单）来自它们公开的说明。

## License

[MIT](LICENSE)
