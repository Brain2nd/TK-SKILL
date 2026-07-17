# KOL 首次建联 Agent

本目录实现首次建联闭环：接收人物画像模块筛选结果，使用默认询价文案或甲方提供的锁定 Offer 模板生成画像 Hook，审批后幂等发送首封，并识别回复、结构化交接。默认询价 7 天后可在原 thread 跟进一次；固定 Offer 未配置专用跟进文案时自动禁用跟进。

职责边界止于首次回复/跟进，不自动执行品牌报价、砍价、合同或 step02–step09。`scaffolds/tikhub-kol-analyzer/` 由人物画像负责人维护，本 Agent 只消费其只读快照。

## 安全默认

- 所有外部写入/发送命令默认 dry-run。
- 候选人必须有筛选批准，正式发送还必须使用单独批准的不可变批次。
- `--execute` 不能直接重建候选集合或正文，只能消费已批准 manifest。
- Provider 调用前写 `sending` 预留事件；未知发送结果不自动重试。
- 同一 `campaign_id + candidate_id + step01` 只允许发送一次。
- 同一标准化邮箱/DM 端点在审批批次、单次运行和同 Campaign 历史事件三层去重，candidate ID 或 handle 变化不能绕过。
- SMTP 前预分配并落盘稳定 Message-ID；出现 `sending`/`delivery_unknown` 时立即熔断全部外发，跨重启也保持停发。
- 运行锁绝不自动接管“疑似过期”锁；必须先核对 journal 与 Sent 邮箱，再人工处理锁文件。
- Do Not Contact、退订、投诉、退信进入 suppression。
- 默认不允许 TikTok DM fallback。

## 数据流

```text
画像快照 JSON/JSONL 或兼容 CSV
  → import_candidates.mjs（默认预览）
  → Feishu creators / 00_Discovered
  → auto_outreach.mjs dry-run
  → pending batch manifest
  → 人工审核 + SHA-256 批准
  → 首封发送 + immutable journal + CRM log
  → 01_FirstOutreach
  → first_outreach_monitor.mjs
       ├─ 回复：报价/币种/授权/媒体包入库 → Outreach Pool=Private
       └─ 7 天无回复：询价模板仅跟进一次；禁用跟进的 Offer 模板跳过
```

## 中文项目工作台

`ui/` 提供可直接运行的中文 Campaign 管理界面，把本目录的安全能力串成完整操作链路：

- 新建项目、选择达人和目标数量；
- 配置项目默认发件邮箱及逐达人覆盖；
- 输入英文母模板；
- 使用达人公开字段生成证据约束的 AI Hook；
- 逐封预览和人工批准不可变批次；
- 第二次 LIVE 确认后，由本地网关顺序发送。

AI 只允许返回 `{{personalized_hook}}` 和引用的 `evidence_ids`，不能改写锁定的报价、交付、CTA 或签名。AI Key 与 SMTP 应用密码均为只写字段，只驻留本地网关内存。完整启动、配置和故障处理说明见 [`ui/README.md`](ui/README.md)。

## 安装与配置

要求 Node.js 20.19+：

```bash
npm ci
cp config.example.json config.json
```

至少配置：

- Feishu App ID/Secret、Base token 和 creators/email log/pipeline log/deadline 表 ID；
- `campaign_id`；
- SMTP/IMAP 和 `sender_accounts`；
- `our_brand_name`、`brand_description`、默认 deliverable；
- 可选 Anthropic Key；缺少时自动使用固定模板。

`config.json`、邮箱状态、journal、锁和批次文件均已加入 `.gitignore`。

## 1. 初始化首次建联字段

先预览：

```bash
npm run outreach:setup
```

确认后创建缺失字段：

```bash
npm run outreach:setup -- --execute
```

新增字段只属于建联工作流，包括候选稳定 ID、筛选追踪、允许渠道、suppression、报价、回复状态和公私域状态；不会修改画像评分逻辑。

## 2. 导入候选人

推荐输入是 `outreach-candidate.v1` JSON/JSONL：

```bash
node import_candidates.mjs --file candidates.jsonl
node import_candidates.mjs --file candidates.jsonl --execute
```

兼容旧版筛选终稿 CSV：

```bash
node import_candidates.mjs --file candidates_final.csv \
  --approve-legacy-final-csv \
  --screening-run-id screening-2026-07-16 \
  --execute
```

CSV 没有显式筛选批准时默认保持未批准；`--approve-legacy-final-csv` 只能在人工确认它确为最终筛选结果后使用。

正式 JSON/JSONL 必须提供稳定 `candidate_id`。导入器以它为主键；同一 handle 指向不同 ID 时会拒绝，防止账号改名或 handle 复用后联系错人。给历史 CRM 行首次绑定稳定 ID 还需人工核对后显式加 `--bind-legacy-handles`。

## 3. 输入固定模板（可选）

自定义首封使用 `first-contact-template.v1` JSON。模板必须把唯一可变文案放在独立 `{{personalized_hook}}` 段落，并用 `locked_blocks` 列出不可改的商业正文。可替换字段仅限 Hook 和确定性的 `creator_name`、`creator_handle`、`sender_name`、`brand_name`。

西班牙 €20 模板示例位于 `outreach_templates/spain-tiktok-shop-eur20.json`。离线验证人物画像交接：

```bash
npm run outreach:preview-analyzer
```

默认读取画像模块的 `output/tts_l1_eu/final.csv`，输出 JSON/HTML 审批预览；该命令的 SMTP、TikTok DM 和 Feishu 写入固定为 0，也不会生成可执行批准清单。

## 4. 生成、审批并发送首封

生成预览和待批准批次：

```bash
npm run outreach -- --limit 25 \
  --write-batch outreach_batches/campaign-001.json
```

使用甲方模板：

```bash
npm run outreach -- \
  --template outreach_templates/spain-tiktok-shop-eur20.json \
  --limit 25 \
  --write-batch outreach_batches/spain-eur20.json
```

检查 JSON 中每条收件人、发件箱、subject、正文和个性化状态，然后批准：

```bash
npm run outreach:approve -- \
  --batch outreach_batches/campaign-001.json \
  --by reviewer@example.com \
  --confirm
```

若批次仍有 `review_warnings`，批准命令默认拒绝。应先核实并更新画像/CRM 后重新生成；只有审核人明确承担残余风险时，才额外使用 `--accept-review-warnings`。

只发送这个批准版本：

```bash
npm run outreach:execute -- \
  --batch outreach_batches/campaign-001.json
```

批准后修改收件人、发件人、subject、正文、模板版本、Hook 证据或审核警告都会导致哈希校验失败。`--execute` 不接受 `--template`，只发送批准清单中冻结的正文。执行时还会重新检查 stage、邮箱、渠道、suppression、幂等日志和邮箱当日额度。

## 5. 回复与一次跟进

先只预览：

```bash
npm run outreach:monitor
```

确认配置与判定后，将 `enable_first_outreach_monitor` 设为 `true`：

```bash
npm run outreach:monitor:execute
```

回复优先通过 `In-Reply-To/References` 匹配已发送 Message-ID。缺少 thread header 时，只有发件地址唯一、时间晚于首封且规范化 subject 相同才回退，并强制进入人工 `Review`。分类结果：

- `rate_quote` / `interested`：记录金额、币种、授权和媒体包，设为 `Private`；
- `declined`：进入 `Rejected`；
- `unsubscribe` / `bounce`：设 Do Not Contact 并进入 `Suppressed`；
- `needs_review`：进入人工 `Review`；
- `out_of_office`：只记录，不推进后续合作。

跟进由邮件首封 `sent` 时间计算。`rate_inquiry_7d` 满 7 天且没有 `reply_received` 时发送一次；`followup_mode=disabled`（当前固定 Offer 的强制设置）直接跳过。流程不依赖开信像素、不随机换邮箱，也不自动进入 step02。DM 首触不会跨渠道触发邮件跟进；发送前还会重新读取达人状态、退订标记、邮箱与 `Allowed Channels`，并执行一次轻量 IMAP 回复屏障检查。

## 状态与对账

`outreach_journal.jsonl` 是本地不可变 outbox/event log。关键状态：

- `sending`：已占用幂等键，Provider 调用尚未确认；
- `failed`：Provider 明确拒绝，修复原因后可重试；
- `delivery_unknown`：可能已经发送，必须查 Sent 邮箱/Provider 后人工对账；
- `delivery_not_sent`：人工核对 Provider/Sent 后明确确认未发送，才允许解除该次尝试；
- `sent`：Provider 已接受并保存 Message-ID；
- `reply_received` / `reply_synced`：回复已记录/已同步 CRM。

如果出现 `sent_pending_sync` 或 `reply_received` 后未出现 `reply_synced`，不要重发或依赖 IMAP 扫描窗口碰运气；补偿器会依据 journal 和稳定 Message-ID/reply key 修复 CRM。Pipeline 已改到目标阶段但日志或 DDL 表部分失败时，也会幂等补齐缺失记录。

先预览待补偿记录：

```bash
npm run outreach:reconcile
```

确认后设置 `enable_outreach_reconciliation: true`，再运行：

```bash
npm run outreach:reconcile:execute
```

`outreach:reconcile` 会列出所有 `sending`/`delivery_unknown`，但不会自动猜测结果。人工核对后先 dry-run 预览解析动作；只有增加 `--confirm` 才写入 journal：

```bash
npm run outreach:resolve-delivery -- \
  --attempt-id <attempt-id> \
  --resolution sent \
  --message-id '<outreach.attempt-id@example.com>' \
  --note 'Checked provider Sent folder'

npm run outreach:resolve-delivery -- \
  --attempt-id <attempt-id> \
  --resolution not-sent \
  --note 'Checked provider and Sent folder: no delivery' \
  --confirm
```

解析为 `sent` 时也必须在核对无误后加 `--confirm`。Message-ID 不匹配会拒绝写入；普通 `failed` 不能覆盖粘性的 `delivery_unknown`。

补偿命令只写 CRM，不调用 SMTP/DM Provider；存在任何补偿失败时以非零状态退出。`outreach_journal.jsonl` 只适合当前单机部署，如果筛选 loop 与建联 Agent 分布在不同机器，需替换为共享事务型 outbox/event sink。

## 邮箱池

`sender_daily_cap` 默认 50/邮箱/自然日，时区由 `outreach_timezone` 控制。预览时使用虚拟计数分配发件箱；执行时逐封重新检查真实额度。首封和 monitor 共用同一个进程锁，避免本机两个任务同时消耗额度。

## 测试

```bash
npm test
```

测试覆盖候选门禁、锁定模板、画像 Hook、EU CSV 对接、不可变批准批次、outbox 预留、未知发送结果、CRM 同步失败、HTML 个性化、并发锁、报价提取、回复交接及分意图跟进策略。

## 旧流程警告

`auto_reply_monitor.mjs` 是原半成品的 step02–step09 自动推进器。代码层已将 `01_FirstOutreach` 从其可操作阶段中移除，避免历史 cron 绕过新 Agent 的意图感知跟进规则。默认 `npm run monitor` 已切换到安全的首次建联 monitor。旧流程没有统一 outbox、稳定 DM inbound ID 和完整幂等保护，因此默认由 `enable_legacy_outbound_monitor: false` 禁用；迁移完成前不要开启 `npm run monitor:legacy`。
