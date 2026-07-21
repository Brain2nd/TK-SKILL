---
name: kol-first-outreach
description: "KOL 首次建联闭环：接收并校验已筛选达人快照，使用默认询价文案或人工提供的锁定 Offer 模板生成画像 Hook，审批不可变 step01 批次并幂等发送；识别回复并结构化交接。用于首次建联、固定模板轻量个性化、批次审批、回复入库与公域转私域；不用于砍价、合同及 step02 以后的履约。"
---

# KOL First Outreach

只执行首次建联闭环，边界止于“回复信息已结构化并交接”或“适用模板的一次跟进已完成”。复用 `scaffolds/kol-email-outreach/`，不修改人物画像评分、人口属性或筛选权重。

## 开始前

1. 读取 [references/input-contract.md](references/input-contract.md) 校验画像快照和 CRM 字段。
2. 使用甲方模板时读取 [references/template-input.md](references/template-input.md) 校验 Schema、锁定段和 Hook 插槽。
3. 读取 [references/message-policy.md](references/message-policy.md) 审核首封及跟进文案。
4. 读取 [references/state-and-idempotency.md](references/state-and-idempotency.md) 处理批次审批、失败重试或对账。
5. 修改代码或验收时读取 [references/validation-matrix.md](references/validation-matrix.md)。

## 工作流

在 `scaffolds/kol-email-outreach` 下执行。

运行环境要求 Node.js 20.19+。

### 1. 初始化 CRM 字段

先预览缺失字段：

```bash
npm run outreach:setup
```

确认后才创建字段：

```bash
npm run outreach:setup -- --execute
```

### 2. 导入画像模块的只读结果

首选 `outreach-candidate.v1` JSON/JSONL。导入命令默认只预览：

```bash
node import_candidates.mjs --file candidates.jsonl
node import_candidates.mjs --file candidates.jsonl --execute
```

兼容旧版最终 CSV 时，只有人工确认该文件确为筛选终稿后才能批准：

```bash
node import_candidates.mjs --file candidates_final.csv \
  --approve-legacy-final-csv --screening-run-id RUN_ID --execute
```

### 3. 生成不可变预览批次

```bash
npm run outreach -- --limit 25 \
  --write-batch outreach_batches/CAMPAIGN_ID.json
```

甲方提供固定 Offer 时，先按 [references/message-policy.md](references/message-policy.md) 创建 `first-contact-template.v1`，再传入模板文件：

```bash
npm run outreach -- \
  --template outreach_templates/APPROVED_TEMPLATE.json \
  --limit 25 \
  --write-batch outreach_batches/CAMPAIGN_ID.json
```

模板必须有独立的 `{{personalized_hook}}` 段落和 `locked_blocks`。AI 只能返回 Hook；subject、价格、交付、链接要求、CTA 和签名由本地渲染器锁定。固定 Offer 在有配套跟进模板前必须设 `followup.mode=disabled`。

逐条检查收件人、发件箱、subject、完整正文、个性化依据和跳过原因。不得把候选人的筛选通过当成这一批邮件的发送批准。

### 4. 批准批次

```bash
npm run outreach:approve -- \
  --batch outreach_batches/CAMPAIGN_ID.json \
  --by REVIEWER --confirm
```

批准动作会对收件人、发件箱、正文、内容模板身份、画像证据和审核警告生成 SHA-256。批准后修改任何内容都会使批次失效。存在 `review_warnings` 时默认不批准；先核实并重新生成，确需保留风险时由审核人额外传 `--accept-review-warnings` 明确认领。

### 5. 只发送已批准内容

```bash
npm run outreach:execute -- \
  --batch outreach_batches/CAMPAIGN_ID.json
```

同一 `campaign_id + candidate_id + step01` 只能进入一次发送窗口。Provider 调用前先写 `sending`；未知结果必须人工对账，不能自动重发。只有确认发送成功才推进 `00_Discovered → 01_FirstOutreach`。

### 6. 处理回复和 7 天跟进

先预览收件箱判定和到期跟进：

```bash
npm run outreach:monitor
```

核对后在 `config.json` 设置 `enable_first_outreach_monitor: true`，再执行：

```bash
npm run outreach:monitor:execute
```

回复优先按 `In-Reply-To/References → outbound Message-ID` 归属。无 thread header 时，只有唯一邮箱、首封之后的时间和相同 subject 同时成立才回退，并强制进入人工 `Review`。`rate_quote` 或 `interested` 写入报价字段并把 `Outreach Pool` 设为 `Private`；退订/退信进入 suppression；低置信度进入 `Review`。邮件首触没有回复时，从成功时间起满 7 天，使用原发件箱在原 thread 中只跟进一次，不依赖开信像素。DM 首触不跨渠道发邮件跟进，并在发送前重新校验 `Allowed Channels`。

### 7. 补偿 CRM 同步失败

`sent_pending_sync` 不得重发，`reply_received` 未同步也不得等 IMAP 再次碰到。先预览 `npm run outreach:reconcile`；确认后设置 `enable_outreach_reconciliation: true`，运行 `npm run outreach:reconcile:execute`。该流程从 journal 幂等补首封、回复、Pipeline 日志和 DDL 的 CRM 状态，不调用 Provider；失败时返回非零退出码。

## 完成标准

- 首封、回复和跟进均有 `outreach_journal.jsonl` 事件及可追溯 Message-ID。
- SMTP/DM 已接受但 CRM 未同步时显示 `sent_pending_sync`，不会重发。
- 报价、币种、授权和媒体包已入库；有意向达人已转为私域。
- 退订、投诉、退信或 Do Not Contact 不再进入任何发送批次。
- 不运行旧 `auto_reply_monitor.mjs`，不自动进入 step02–step09。

## 约束

- 默认询价意图只询问当前报价、币种、媒体包和基础 usage-rights 口径，不给预算或合作承诺。
- 固定 Offer 意图只允许使用甲方已批准且锁定商业段落的模板，不得让 AI 改写价格、交付、CTA 或签名。
- AI 只生成一个有公开 Bio、分类、Handle 或近期视频证据支持的 Hook；不得虚构视频、合作品牌、业绩或个人事实。
- 不用肤色、人种、年龄、地址、银行资料等敏感画像生成文案。
- 执行前必须具备候选人筛选批准和不可变邮件批次批准，两者缺一不可。
