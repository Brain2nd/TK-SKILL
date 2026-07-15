# JoyaGoo KOL CRM — 使用说明

## 系统概览

自动化 KOL 建联与跟进系统，基于飞书多维表格作数据库，通过邮件 + TikTok DM 双渠道与达人沟通，由 Claude 驱动个性化内容生成。

```
达人库（飞书）
    │
    ▼
auto_outreach.mjs          ← 定时运行：扫描待建联达人，发首封邮件 + TikTok DM
    │
    ▼
auto_reply_monitor.mjs     ← 定时运行：扫描收件箱，分类回复，自动推进 pipeline
    │
    ▼
飞书多维表格               ← 记录 pipeline 状态、邮件日志、deadline
```

---

## 配置文件

所有配置集中在 `config.json`，不使用环境变量。先复制安全模板：

```bash
cp config.example.json config.json
```

| 字段 | 说明 |
|------|------|
| `feishu_app_id` / `feishu_app_secret` | 飞书开放平台应用凭证 |
| `kol_crm_app_token` | 飞书多维表格的 Base Token |
| `kol_tbl_*` | 各子表的 Table ID |
| `sender_accounts` | 发件邮箱池（name/user/pass） |
| `smtp_host` / `imap_host` | 邮件服务器（当前：飞书企业邮箱） |
| `smtp_port` / `imap_port` | 端口（SMTP 465 SSL / IMAP 993 SSL） |
| `anthropic_api_key` | Claude API Key（用于个性化邮件生成） |
| `tikhub_api_key` | TikHub API Key（用于 TikTok DM） |
| `track_host` | 邮件开信追踪服务地址 |
| `our_brand_name` / `brand_domain` | 品牌名和域名 |
| `default_sender_name` | 默认发件人昵称（当前：claire） |
| `personalize_model` | Claude 个性化模型 |

---

## 飞书多维表格结构

Base Token：在 `config.json` 中配置 `kol_crm_app_token`。

| 表名 | Table ID | 用途 |
|------|----------|------|
| creators（数据表） | `YOUR_CREATORS_TABLE_ID` | 达人主表，含评分、联系方式、pipeline 状态 |
| pipeline_log | `YOUR_PIPELINE_LOG_TABLE_ID` | 每次 stage 推进记录 |
| email_log | `YOUR_EMAIL_LOG_TABLE_ID` | 所有出站/入站邮件日志（含线程 Message-ID） |
| deadlines | `YOUR_DEADLINES_TABLE_ID` | 各 stage 的 deadline 跟踪 |
| business_config | `YOUR_BUSINESS_CONFIG_TABLE_ID` | 业务配置参数 |
| manual_events | `YOUR_MANUAL_EVENTS_TABLE_ID` | 人工事件记录 |
| daily_summary | `YOUR_DAILY_SUMMARY_TABLE_ID` | 每日汇总 |

> **注意**：写入飞书走 `lark-cli --as user` 用户 token。读取走 SDK 机器人 token。两套权限互相独立，不可混用。

---

## Pipeline 阶段

```
00_Discovered       → 达人已导入，待建联
01_FirstOutreach    → 已发首封邮件/TikTok DM
02_CollabOffer      → 达人回复感兴趣，已发报价
03_Agreed           → 达人同意合作
04_ContractSigned   → 合同已签，充值已到账
05_TeaserDraftDue   → 等待预热视频草稿
06_PackageShipped   → 包裹已寄出
07_PackageDelivered → 包裹已送达
08_TryOnVideo       → 等待试穿+Q&A 视频
09_Completed        → 合作完成
XX_Dropped          → 已放弃（不感兴趣/失联）
```

### 报价规则（按粉丝量自动计算）

| 档位 | 粉丝量 | 购物余额 | 免运费额度 |
|------|--------|----------|------------|
| Nano | 1.5k–5k | 300 CNY | 3 kg |
| Micro | 5k–50k | 500 CNY | 3–5 kg |
| Mid | 50k–200k | 800 CNY | 5–10 kg |
| Macro | 200k+ | 1200 CNY | 5–10 kg |

---

## 邮件模版

模版存储在本地 `templates.json`（13 条），修改后下次运行自动加载，无需重启。

| Template ID | Step | 触发时机 |
|-------------|------|----------|
| `step01` | 1 | 首次建联 |
| `step02` | 2 | 达人回复感兴趣 → 发报价 |
| `step02_followup` | 2 | 超 1 周无回复 → 跟进一次 |
| `step02_declined` | 2 | 达人明确拒绝 → 礼貌致谢 |
| `step03a` | 3 | 同意合作 + 已通过联盟链接注册 |
| `step03b` | 3 | 同意合作 + 未用联盟链接注册 |
| `step04` | 4 | 合同已签 + 发预热视频指引 |
| `step05` | 5 | QC 通过，催预热视频草稿 |
| `step06` | 6 | 包裹已寄出 |
| `step07` | 7 | 包裹已送达 |
| `step08` | 8 | 开箱视频发布后，要求试穿+Q&A |
| `step09` | 9 | 视频播放 >20k，沟通置顶 |
| `step10` | 10 | ≥20 注册 + ≥5 下单，发产品推荐表 |

### 模版变量

| 变量 | 说明 |
|------|------|
| `{{creator_name}}` | 达人用户名 |
| `{{your_name}}` | 发件人昵称（当前：Claire） |
| `{{offer_amount}}` | 报价金额（按粉丝量自动计算） |
| `{{shipping_weight}}` | 免运费重量（按粉丝量自动计算） |
| `{{affiliate_link}}` | 达人专属联盟链接（从 creators 表读取） |
| `{{tracking_number}}` | 物流单号 |
| `{{registration_count}}` | 注册数（step08/10 需从后台获取） |
| `{{commission_amount}}` | 佣金数（step08/10 需从后台获取） |

所有邮件在发送前由 Claude 根据达人主页内容自动改写，个性化失败时回退原始模版。

---

## 运行方式

### 安装依赖

```bash
cd /home/ubuntu/kol_crm_source
npm install
```

### 手动运行

```bash
# 自动建联：找所有 00_Discovered 的达人，发首封邮件 + TikTok DM
node auto_outreach.mjs

# 回复监控：扫描收件箱，处理回复，自动推进 pipeline
node auto_reply_monitor.mjs
```

### 定时任务（cron）

```bash
# 编辑 crontab
crontab -e

# 每天 09:00 建联
0 9 * * * cd /home/ubuntu/kol_crm_source && node auto_outreach.mjs >> /var/log/kol_outreach.log 2>&1

# 每 2 小时回复监控
0 */2 * * * cd /home/ubuntu/kol_crm_source && node auto_reply_monitor.mjs >> /var/log/kol_monitor.log 2>&1
```

### 查看发件池状态

```bash
node -e "import('./sender_pool.mjs').then(m => console.log(JSON.stringify(m.getPoolStatus(), null, 2)))"
```

---

## 邮件开信追踪

追踪服务：`http://3.21.171.47:18791`

每封 HTML 邮件自动嵌入 1×1 追踪像素。查看日志：

```bash
curl http://3.21.171.47:18791/track/list
```

| type | 含义 |
|------|------|
| `prefetch` | Gmail/Outlook 预加载，不算真实开信 |
| `open` | 真实开信 |

---

## 操作流程

### 添加待建联达人

在飞书 `creators` 表将达人 `Pipeline Stage` 设为 `00_Discovered`，系统下次运行 `auto_outreach.mjs` 时自动处理。

### 手动推进 pipeline

直接在飞书修改 `Pipeline Stage` 字段，系统下次运行 `auto_reply_monitor.mjs` 时跟进对应 step。

### 放弃某个达人

在飞书将 `Pipeline Stage` 改为 `XX_Dropped`，系统不再跟进。

### step08 / step10 需人工介入

`{{registration_count}}` 和 `{{commission_amount}}` 需从网站后台获取实际数据后，手动触发对应邮件发送。

### 修改邮件模版

编辑 `templates.json` 中对应条目，无需重启，下次运行生效。

---

## 注意事项

1. **lark-cli 登录**：写入飞书依赖 lark-cli 用户 token，长期不用需重新登录：
   ```bash
   lark-cli auth login
   ```

2. **TikTok DM**：依赖 CDP 浏览器自动化，需本地有已登录的 Chrome 实例运行在端口 `18800`

3. **发件上限**：每个邮箱账号每日 50 封上限，超出自动跳过，次日 UTC 00:00 重置（计数存在 `sender_state.json`）

4. **邮件线程**：系统自动维护 In-Reply-To / References，同一达人的后续邮件显示在同一对话线程

5. **Claude 个性化**：使用 `claude-sonnet-4-6` 改写模版，有 API 费用，失败时自动回退原始模版

---

## 文件结构

```
kol_crm_source/
├── config.json                    # 所有配置
├── templates.json                 # 邮件模版（13 条）
├── sender_state.json              # 发件池今日计数（自动生成）
├── auto_outreach.mjs              # 入口：自动建联
├── auto_reply_monitor.mjs         # 入口：回复监控
├── sender_pool.mjs                # 发件池（round-robin，50/天/账号）
└── lib/
    ├── config.mjs                 # config.json 加载器
    ├── kol_crm.mjs                # 核心逻辑（飞书读写、pipeline、模版渲染）
    ├── email_thread_builder.mjs   # 邮件线程续接
    ├── imap_email.mjs             # IMAP 收件扫描
    ├── claude_personalizer.mjs    # Claude 邮件个性化
    ├── tiktok_dm.mjs              # TikTok DM（CDP）
    └── tracking_aggregator.mjs    # 开信追踪聚合
```
