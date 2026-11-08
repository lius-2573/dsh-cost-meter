# 新版 Ollama Pro

[English](ollama-pro.en.md)

本 fork 基于上游 v1.9.60。新增额度来源 ID 为 `ollama-cloud`，不与本地 `ollama` 推理来源混用。仅支持新版月度美元额度套餐；旧版 session/weekly 套餐会明确提示不支持，不显示虚构的零额度。

## 配置

1. 在 [Ollama API Keys](https://ollama.com/settings/keys) 创建用于自己账户的 API Key。
2. 打开 DSH 的“设置 → 费用 → 额度”，找到“Ollama Cloud”卡片。
3. 在凭据框保存 Key，启用该来源，选择显示位置并刷新。凭据目标为 `codingPlans.ollama-cloud`，引用名为 `OLLAMA_API_KEY`；也支持宿主同名环境变量。
4. 默认刷新间隔为 5 分钟；即使手动连续刷新，也会复用一分钟内的结果。官方返回 `Retry-After` 时延长等待。

Key 不写入账本、仓库或浏览器状态，只有宿主向固定的 `https://ollama.com` 发送只读查询；不跟随重定向。不要把 Key 放进 URL、提交记录或聊天。

## 展示口径

- 月度总额、剩余额度、购买余额和重置日期来自 [Balance](https://docs.ollama.com/api/balance.md)。已用额度由“总额 − 剩余”计算；总额为零时不编造百分比。
- 侧边栏在百分比之外显示“本月额度”上限，例如 `$60`；选择人民币时按当前汇率显示对应金额。额度来自官方返回值，不固定写死为 60，不包含购买余额；窄栏可在悬停提示中查看。
- 近 24 小时、7 天、30 天的金额、请求与 Token 来自 [Cloud usage](https://docs.ollama.com/api/cloud-usage.md)。这些是官方窗口，不等于本地自然日／自然月，界面可查看实际起止时间；统计可能有更新延迟。
- 官方账户统计可包含其他工具调用；不是当前 DSH 会话账单，不重复写入本地费用、不变更既有 API / Plan 分类。
- 缺失字段或失败窗口显示不可用，而不是零。临时失败保留上次成功余额与原始查询时间，提示数据可能过期；密钥更换、来源停用时清除旧账户缓存。
- 金额按照当前费用显示币种折算；接口原值为 USD。购买余额独立于月度剩余额度，不把两者相加后伪造套餐百分比。

## 安装、同步与回滚

Fork tag 推送后，可固定安装：

```sh
dsh plugin --profile web add github:lius-2573/dsh-cost-meter#v1.9.62-ollama.1
```

也可以通过 DSH 官方 CLI 安装经测试的本地 `.tgz` 包。安装后重启 DSH，并刷新原 GUI。恢复官方版本时使用 `dsh plugin --profile web add dsh-cost-meter@1.9.60`，再重启、刷新；必要时使用安装前的本地快照恢复配置，勿清空会话或账本。

上游 remote 为 `upstream`，功能分支为 `feature/ollama-quota`。同步时先合并上游并运行构建／回归，审核后再更新安装版本；本次未创建定时同步任务，也未向上游提交 PR。
