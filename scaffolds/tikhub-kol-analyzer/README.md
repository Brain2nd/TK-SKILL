# TikHub KOL Analyzer

面向 TikTok、Instagram 和 YouTube 的达人检索、分析与联系方式补全工具。项目只启动
一个 `creator-search` MCP 服务，并在内部隔离两条数据路径：TikHub API 与 FastMoss
用户浏览器会话。

- TikHub：Agent 每次搜索前向用户询问 API Key；Key 只用于当前工具调用。
- FastMoss：首次或会话过期时向用户询问账号密码；爬虫不保存凭证，只保存网站会话。
- 用户未指定数据源时，Agent 必须先询问，不能擅自同时调用两边。

## 安装

```bash
cp .env.example .env
./setup.sh
```

要求 Python 3.10+。安装脚本会创建 `.venv`、安装锁定依赖、安装 Playwright Chromium
并运行环境检查。

## 启动 MCP

```bash
./run_mcp.sh
```

打印可复制的 MCP 客户端配置：

```bash
.venv/bin/python shared/print_mcp_config.py
```

Claude Code 也可以直接添加：

```bash
claude mcp add --scope local creator-search -- "$(pwd)/run_mcp.sh"
```

## 主要能力

- 按关键词搜索 TikTok 创作者。
- 根据国家、粉丝数、播放量、互动率、销量、GMV 和类别筛选达人。
- 使用持久浏览器会话抓取 FastMoss Creator Search 当前账号可见的数据。
- 在真实浏览器页面上下文执行固定采集脚本，复用浏览器自身的 TLS/HTTP 网络栈；不模拟
  DevTools 粘贴，也不伪造 TLS 指纹。
- Agent 只能通过 `SearchCriteria` 白名单传入国家、粉丝数、销量、关键词和数量等结构化
  参数；采集与邮箱脚本不会由 Agent 动态生成或按文本替换。
- 在一次 FastMoss 会话中轮换多个关键词，并兼容新版 Ant Design Select 搜索框。
- 用 `discover_spain_creators_deep` 并行执行 FastMoss 批量关键词与 TikHub 多轮发现。
- 检查 TikTok 账号和近期视频表现。
- 分析账号特征、互动率和受众信息。
- 搜索 Instagram 用户和 YouTube 频道。
- 从公开资料补全联系方式，并可选执行邮箱 DNS 检查。
- 将候选人 CSV 同步到飞书多维表格。

运行 `get_runtime_status` 可检查 Python/Playwright 依赖、FastMoss 会话和飞书配置状态。

## Agent 调用顺序

1. 收集达人特征及结果数量。
2. 用户未指定时，询问使用 `tikhub` 还是 `fastmoss`。
3. 调用 `get_creator_search_access`。
4. TikHub 路径询问 API Key，再调用 `search_tikhub_creators_by_features`。
5. FastMoss 路径仅在需要登录时询问账号密码，再调用
   `search_fastmoss_creators_by_features`。浏览器出现 CAPTCHA/短信验证时由用户完成。

中文站登录会自动执行：`登录/注册` → `手机号登录/注册` → `密码登录`。账号密码只会
填入 `https://www.fastmoss.com/zh` 域名下弹出的登录表单。

FastMoss 也提供本地调试入口：

```bash
# 密码通过隐藏提示输入，不进入命令行历史
.venv/bin/python -m fastmoss_pipeline.scraper login --username YOUR_ACCOUNT

.venv/bin/python -m fastmoss_pipeline.scraper search \
  --criteria '{"keywords":["belleza","hogar","unboxing"],"countries":["ES"],"max_followers":10000}' \
  --limit 500 --output output/fastmoss/example.csv
```

正式自动化流程分成两个阶段：Playwright 通过页面响应与 DOM 可靠翻页收集候选，然后读取
`fastmoss_pipeline/browser_email_enrichment.js` 作为固定、受版本控制的页面脚本补全邮箱。
Agent 只传结构化配置；浏览器内下载关闭，结果由 Python 回收并写入 CSV 与 JSON 审计文件。
JSON 审计会记录候选数、处理数、邮箱数、目标数和分页警告。遇到验证码、短信验证、限流
或封禁时会停止或等待人工处理，不会切换身份规避风控。

`run_multi_round_search` 现在接受 `keywords` 列表，默认轮次间隔为 0 秒；需要跨天采样时再
显式设置 `interval_seconds`。西班牙双源深度发现会分别保存 FastMoss CSV 和 TikHub
`final.csv`，并在返回值的 `sources` 中保留两路状态。

## 配置

核心变量见 `.env.example`：

- `TIKHUB_API_KEY`：仅供旧脚本使用；Agent 搜索流程使用每次调用传入的临时 Key。
- `ANTHROPIC_API_KEY`：需要 LLM 分析时使用。
- `DEEPSEEK_API_KEY`、`LLM_PROVIDER`、`DEEPSEEK_MODEL`：可选的兼容模型配置。
- `FEISHU_*`：可选的飞书多维表格同步配置。

密钥只放在本地 `.env`，不要写入仓库、命令行参数或日志。

## 目录

- `tikhub_pipeline/`：TikHub 检索、分析和 MCP 服务。
- `fastmoss_pipeline/`：精简的 FastMoss 持久浏览器爬虫。
- `shared/`：环境加载、联系方式补全、飞书同步及运行时工具。
- `run_mcp.sh`：唯一 MCP 启动入口。
- `output/`：本地审计与结果文件。
