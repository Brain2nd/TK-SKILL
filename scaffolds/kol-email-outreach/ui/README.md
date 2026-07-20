# LOOP Creator OS · 首次建联工作台

> 运营人员首次使用请先阅读仓库根目录的[完整中文用户手册](../../../README.zh-CN.md)；本页主要保留工作台技术细节和开发说明。

面向红人营销团队的中文项目管理界面。系统消费 TikHub 人物画像结果，按项目管理达人、英文邮件母模板、发件邮箱、可选 AI 个性化、人工审批和安全发送。

当前西班牙示例使用 10 位 TikTok 达人和固定 €20 Offer。仓库只包含 dry-run 数据，默认状态下不会发送真实邮件。

## 能做什么

- 新建 Campaign，选择达人并设置目标发送数量。
- 直接上传画像 MCP 或运营表格导出的 CSV、JSON、JSONL，自动校验、去重并加入项目。
- 为项目设置默认发件邮箱，也可逐达人覆盖。
- 编辑英文主题和正文母模板。
- 可选择“纯模板”直接生成，不调用大模型；也可使用达人公开字段生成不同的英文开场。
- 逐封预览 From、To、Subject、Body、画像警告和幂等键。
- 人工批准后冻结不可变批次，再进行第二次 LIVE 发送确认。
- 顺序发送、保存稳定 Message-ID，并在投递结果不明确时全局熔断。
- 使用 D1 保存项目、达人分配、审批批次和审计事件。

## 两种邮件生成方式

- `纯模板（不调用 AI）`：严格使用项目英文模板，只替换发件人签名；如果模板保留 `{{personalized_hook}}`，该独立段落会被移除。无需模型 API Key。
- `AI 个性化开场`：模型只生成一段证据约束的英文开场，报价、链接、交付要求、CTA 和签名仍由项目模板控制。

AI 个性化模式下，正文模板必须包含且只能包含一个独立段落：

```text
{{personalized_hook}}
```

并保留一个发件人签名变量：

```text
{{sender_name}}
```

生成流程如下：

```text
项目英文母模板
  + 达人 handle / bio / 分类标签 / 城市 / 国家 / 近期公开视频
  → AI 仅返回 { hook, evidence_ids }
  → 本地安全校验
  → 合成完整英文邮件
  → 逐封人工审批
  → SHA-256 锁定
  → 正式发送
```

模型不能修改报价、交付要求、CTA 或签名。达人字段和模板都按不可信输入处理；AI 输出必须是一句不超过 240 字符的英文 Hook，不能包含链接、邮箱、价格或换行，并且必须引用本次提供的公开证据。

当模型超时、返回格式错误或证据不足时，系统不会自动重试模型请求，而是回退到基于公开字段的规则文案，并给该邮件增加人工审核警告。

## 系统结构

```text
TikHub Analyzer CSV
  → 首次建联核心模块（筛选门禁、模板校验、规则 Hook）
  → Vinext 中文工作台
       ├─ D1：项目、达人分配、审批批次、审计事件
       └─ 127.0.0.1:8878 本地网关
            ├─ AI Key（只写、仅内存）
            ├─ Gmail / Outlook OAuth 令牌（只写、仅内存）
            ├─ 自定义 SMTP 应用密码（只写、仅内存）
            ├─ AI 个性化结果缓存
            └─ 顺序发送队列、journal、运行锁、熔断器
```

浏览器不会逐封调用邮件服务商。它只提交一次已审批批次；真正的 AI、Gmail API、
Microsoft Graph 或 SMTP 调用均由仅监听本机的网关执行。

## 本地运行

要求 Node.js `>=22.13.0`。

先安装核心模块和工作台依赖：

```powershell
cd scaffolds/kol-email-outreach
npm ci

cd ui
npm ci
```

推荐一条命令同时启动工作台与网关：

```powershell
cd scaffolds/kol-email-outreach/ui
npm run mvp
```

启动前可单独检查环境：`npm run mvp:check`。如需分别查看两个服务的日志，也可以打开两个终端：

```powershell
# 终端 1：中文工作台与本地 D1
cd scaffolds/kol-email-outreach/ui
npm run dev -- --hostname 127.0.0.1 --port 8877

# 终端 2：AI 与邮件发送本地网关
cd scaffolds/kol-email-outreach/ui
npm run gateway
```

打开 <http://127.0.0.1:8877/>。

本地网关固定监听 `127.0.0.1:8878`，不要将其直接暴露到公网。

### Windows 双击启动

Windows 用户可直接双击：

```text
ui/release/LOOP-Creator-OS-MVP.exe
```

EXE 是本地 MVP 启动器，需要保留在项目 `ui/release` 目录中，并要求系统安装 Node.js `>=22.13.0`。首次启动会自动安装缺失的 npm 依赖；启动成功后会打开中文工作台，并提示完成邮件池和可选 API 设置。右下角托盘菜单可打开工作台、查看 `server-data/launcher.log` 或停止本次启动的服务。

如需重新编译 EXE：

```powershell
npm run package:windows
```

当前 EXE 未做商业代码签名，Windows SmartScreen 可能提示风险；正式对外分发前应使用公司的代码签名证书签名。

如需“只填邮箱后授权”的 Gmail / Outlook 连接，启动网关前配置对应的 OAuth 应用：

```powershell
# Gmail（二选一时只需要配置对应服务商）
$env:LOOP_GOOGLE_OAUTH_CLIENT_ID="...apps.googleusercontent.com"
$env:LOOP_GOOGLE_OAUTH_CLIENT_SECRET="..." # Web OAuth 客户端需要；桌面客户端可按 Google 配置决定

# Outlook / Microsoft 365
$env:LOOP_MICROSOFT_OAUTH_CLIENT_ID="..."
$env:LOOP_MICROSOFT_OAUTH_TENANT="common"
$env:LOOP_MICROSOFT_OAUTH_CLIENT_SECRET="..." # 公共客户端可以不填

# 两个服务商的 OAuth Redirect URI 都登记为：
$env:LOOP_OAUTH_REDIRECT_URI="http://127.0.0.1:8878/oauth/callback"
$env:LOOP_UI_ORIGIN="http://127.0.0.1:8877"
npm run gateway
```

## 首次配置

### 0. 导入达人

进入“项目中心”，点击“导入达人”，上传画像模块生成的 CSV、JSON 或 JSONL。系统自动兼容常见字段名称，并执行：

- 达人账号、主页链接和联系邮箱校验；
- 文件内账号与邮箱去重；
- 粉丝数、均播、分类、简介和近期内容证据统一；
- 无效行拒绝导入并显示数量；
- 可选择导入后直接加入当前项目。

单次最多 1,000 位达人、5 MB。缺少有效账号或联系邮箱的记录不会进入可发送达人库。数据契约版本为 `outreach-candidate.v1`。

### 1. 选择邮件生成方式

在项目设置中选择：

- “纯模板（不调用 AI）”：无需 API，适合固定文案批量首联；
- “AI 个性化开场”：按达人公开画像生成不同开场。

### 2. 配置 AI（可选）

只有使用 AI 个性化的项目才需要进入“邮箱账户”页面下方的“AI 个性化配置”：

1. 填写 Anthropic 模型名称，默认 `claude-sonnet-4-6`。
2. 输入 Anthropic API Key。
3. 点击“保存 AI 配置”。

API Key 是只写字段，不写入 D1、配置文件、日志、任务文件或 API 响应。网关重启后需要重新输入。

### 3. 配置发件邮箱

同一页面支持 Gmail、Outlook/Microsoft 365 和自定义 SMTP：

- Gmail / Outlook：填写邮箱、显示名称和每日上限，点击“连接并授权”，在服务商官方页面完成一次 OAuth 授权；
- 自定义 SMTP：另填 SMTP Host、端口、TLS 和应用密码；
- Reply-To 对两种方式都可选。

连接后必须通过“测试连接”。OAuth Token 和 SMTP 密码都只存在当前网关进程内存中；
网关重启后需要重新授权或重新输入密码。OAuth 回调使用一次性 `state` 和 PKCE，授权账号
必须与填写的发件邮箱完全一致。

### 4. 配置项目

1. 新建或选择项目。
2. 选择达人和目标发送数量。
3. 选择项目默认发件邮箱；必要时逐达人覆盖。
4. 选择纯模板或 AI 个性化，并输入英文主题和正文母模板。
5. 保存项目设置。

修改模板、达人名单或发件分配会使尚未发送的旧审批失效。

## 审批与正式发送

1. 在“审批与发送”生成 N 封审批邮件。
2. 系统先校验发件邮箱和收件人；纯模板模式直接合成，AI 模式再逐达人生成 Hook。
3. 生成期间如果项目设置发生变化，快照哈希校验会拒绝创建旧批次。
4. 逐封检查英文邮件与全部人工警告。
5. 输入完整项目名，点击“批准并锁定批次”。
6. 再次输入项目名并勾选 LIVE 确认，才可正式入队。

仓库示例没有发件密码和 AI Key，因此克隆后不会自行发送邮件。

## 防重复和网络故障策略

- D1 先保存确定性 `run_id`，再通知本地网关入队。
- 同一批次重复点击只返回同一个运行实例。
- 所有项目共享运行锁，避免多个项目同时消耗同一个邮箱额度。
- 每封邮件在 SMTP 前写入 `sending` journal，并预分配稳定 Message-ID。
- 任务和逐封结果持久化到 `server-data/send-jobs.json`，该目录不会提交。
- 网关重启不会自动重发未完成邮件，而是保守暂停。
- SMTP 超时、进程中断或结果无法可靠落盘时进入 `delivery_unknown`。
- 一旦存在 `delivery_unknown`，全局熔断器阻止所有后续发送，必须人工核对 Sent 文件夹或服务商记录。
- 当前固定 €20 西班牙项目关闭自动 Follow-up。

## 数据与隐私

- 示例达人数据来自 `scaffolds/tikhub-kol-analyzer/output/eu5_10_tikhub_20260717/final.csv`；真实项目可通过 `KOL_CANDIDATES_FILE` 接收画像 MCP 返回的 `final_file`。
- AI 只接收生成 Hook 所需的公开字段，不接收达人邮箱、付款信息或内部评价。
- OAuth Token、SMTP 密码和 AI Key 都是只写、仅内存凭据。
- `config.json`、`.env*`、D1 本地文件、发送任务、journal、锁和构建产物均被忽略。
- 不要把真实付款信息、合同、地址或私聊记录放入公开仓库。
- 托管环境按已登录用户邮箱隔离项目、发件账户、审批批次和审计事件；本机模式固定使用本地操作员身份。

## MVP 受控发信验收

正式联系达人前，只使用团队内部邮箱完成验收：

1. 连接一个 Gmail、Outlook 或企业测试邮箱并点击“测试连接”。
2. 新建仅包含 1–3 个内部收件地址的测试项目。
3. 生成并逐封审批，确认模板报价、链接和签名不被 AI 改写。
4. 正式发送后在“发送结果与回复”核对状态、时间和 Message-ID。
5. 重复点击发送，确认不会产生第二封；不要用真实达人验证异常场景。

当前 OAuth 只申请发信权限，不读取客户收件箱。“回复同步待启用”是明确的 MVP 边界，不会展示伪造回复。

## 验证

工作台完整验证：

```powershell
cd scaffolds/kol-email-outreach/ui
npm test
```

首次建联核心与工作台安全测试：

```powershell
cd scaffolds/kol-email-outreach
node --test
```

测试不会连接真实 SMTP，也不会发送邮件。覆盖 AI Key/SMTP 密码不回显、模板保护、画像证据、审批哈希、批次幂等、网关重启恢复、稳定 Message-ID 和 `delivery_unknown` 熔断。

## 部署边界

Vinext/D1 页面可以部署到 Cloudflare Sites，但 `127.0.0.1:8878` 本地网关不会随网页部署。当前真实 AI 与 SMTP 模式是本地操作员模式；若要做多人生产部署，应将本地网关替换为受认证的私有服务，并使用正式 Secret Manager、共享事务型 outbox 和队列。

## 关键目录

```text
ui/app/                       中文项目、审批、邮箱和审计界面
ui/app/api/                   D1 与本地网关的服务端接口
ui/db/outreach-store.ts       项目、快照、批次和审批状态
ui/server/outreach-gateway.mjs AI 配置、个性化、SMTP 队列与恢复
ui/windows-launcher/          Windows EXE 启动器源码与构建脚本
ui/release/                   可双击运行的 MVP EXE 与使用说明
ui/tests/                     UI、网关和防重复测试
lib/claude_personalizer.mjs   证据约束的 AI Hook 生成
outreach_templates/           first-contact-template.v1 母模板
```
