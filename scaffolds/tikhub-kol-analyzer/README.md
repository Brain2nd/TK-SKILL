# Dogegoo TikTok KOL Filter

自动筛选 TikTok cosplay / jfashion / 动漫周边品类创作者，面向欧美 + 拉丁美洲市场。

---

## 客户下载后复现

支持在 macOS / Linux 新机器上复现。需要 Python 3.10+、Node.js 20+。数据源按平台
固定路由：TikTok Shop（下文简称 TTS）只使用客户自己的 FastMoss 网页账号；
Instagram 和 YouTube 只使用客户自己的 TikHub API Key。FastMoss 没有 API，因此每个
客户首次安装后必须在浏览器中完成一次登录或验证码；Cookie 只保存在本机，不随项目分发。

```bash
git clone <repository-url>
cd tikhub-kol-analyzer
bash setup.sh

# 如需 Instagram / YouTube，编辑 .env 并填入 TIKHUB_API_KEY
# 如需 TTS，完成一次 FastMoss 浏览器登录
bash fastmoss_browser_setup.sh

# 复制输出的 JSON 到 Claude Code、Codex 或其他 MCP 客户端
.venv/bin/python print_mcp_config.py
```

安装与登录状态可随时检查：

```bash
.venv/bin/python doctor.py
```

安装完成后，MCP 的 `run_shop_discovery` 固定使用 FastMoss，不接受 TikHub 或混合来源；
Instagram / YouTube 使用独立的 TikHub MCP 工具。也可以继续使用下文的命令行入口。
不同时间的网页数据会变化，因此流程和筛选条件可以复现，但候选名单不会保证逐字节相同。Python 和 Node 依赖分别由
`requirements-lock.txt` 与 `package-lock.json` 固定版本。

---

## 环境准备

```bash
bash setup.sh

# setup.sh 会在不存在时创建 .env；编辑后无需手动 source，CLI 与 MCP 会自动读取
```

TTS/Showcase 发现只需要 FastMoss 登录；Instagram / YouTube 查询需要 TikHub Key；
完整 AI 相关性漏斗还需要一个 LLM Key：

- **TIKHUB_API_KEY**：[api.tikhub.io](https://api.tikhub.io) — Instagram / YouTube，及非 TTS 的通用 TikTok 分析；
- **ANTHROPIC_API_KEY**：Claude API — AI 相关性评分，可选。

也可用 `DEEPSEEK_API_KEY` 代替 Anthropic Key。项目通过 DeepSeek 的 Anthropic
兼容接口完成评分；可选设置 `LLM_PROVIDER=deepseek` 与
`DEEPSEEK_MODEL=deepseek-v4-flash`。

---

## 快速开始

### 常规搜索（推荐）

```bash
.venv/bin/python main.py --keyword "cosplay haul"
```

输出到 `output/cosplay_haul/final.csv`，含排名、联系方式、评分详情。

### 多轮跨天搜索（扩大覆盖范围）

```bash
.venv/bin/python main.py --keyword "attack on titan haul" --runs 3 --interval 86400
```

TikTok 搜索池每天缓慢更新，间隔 24h 能覆盖更多创作者。短间隔（5min）新增极少，不推荐。

### 已知达人特征提取（用于阈值校准）

```bash
.venv/bin/python fetch_creator_features.py --file /path/to/creators.xlsx
# 输出：output/creator_features_raw.csv
```

---

## 三层筛选漏斗

```
关键词搜索 → 创作者去重
     ↓
Step 1: Hard Filter（无 API 消耗，即时过滤）
  - 最近发帖 ≤ 35 天
  - 粉丝 ≥ 1,500
  - 平均播放 ≥ 2,000
  - 最高单视频播放 ≥ 3,000
  - 平均视频时长 ≥ 10 秒
  - 内容垂直度 ≥ 10%
     ↓
Step 2: Must-Pass Filter（需调用评论 + Claude + 假流量 API）
  - 平均评论数 ≥ 3
  - 评论率 ≥ 0.0005
  - AI 相关性评分 ≥ 0.6（Claude 打分）
  - 西方受众比例 ≥ 30%（含 BR/MX/CL/AR/CO）
  - 互粉观看比 ≥ 0.02
  - 虚假评分 ≤ 60，信任评分 ≥ 50
     ↓
Step 3: 加权评分排名（16 维度）
  - 转化潜力 40% + 流量质量 25% + 受众忠诚 20% + 内容匹配 10% + 合作准备度 5%
```

---

## 关键词库

`search_keywords.py` 中预设 60 个关键词，按优先级分三层：

| 层级 | 示例 |
|------|------|
| Tier 1（最高）| cosplay haul, taobao haul, anime merch haul, jfashion haul |
| Tier 2（高）  | danmei, lolita fashion, kawaii fashion, figure collection |
| Tier 3（中）  | attack on titan, genshin impact, jujutsu kaisen, hololive |

---

## 输出文件

| 文件 | 内容 |
|------|------|
| `output/<keyword>/final.csv` | 最终候选，含 email、instagram、bio_url、评分 |
| `output/<keyword>/step1.csv` | Step 1 通过的中间结果（checkpoint，支持断点续跑）|
| `output/creator_features_raw.csv` | 历史合作达人特征（阈值校准基础）|

**注意：FastMoss 浏览器 Cookie 位于 `output/.fastmoss-browser-profile/`，始终被
`.gitignore` 排除，不应交给其他客户。**

### Shop 发现输出字段

TTS 数据只来自 FastMoss。最终合格行的 `shop_proof` 固定为
`shop_showcase_verified`；具体证据保存在 `shop_proof_method`，方便统一筛选和审计。

| 字段 | 作用 |
|------|------|
| `rank` | 最终排序；优先西班牙，再按可用销售数据和粉丝量排序。 |
| `username` | 规范化 TikTok 用户名，不含 `@`。 |
| `status` | 检查状态；最终文件中通常为 `qualified`。 |
| `reason` | 未通过原因；合格行为空。 |
| `source` | TTS 候选来源，必须以 `fastmoss` 开头，例如 `fastmoss_web`。 |
| `country` | 达人国家，两位 ISO 代码，例如 `ES`、`FR`。 |
| `followers` | 抓取时的粉丝数快照。 |
| `avg_views_10` | 最近最多 10 条视频的平均播放量；FastMoss 未提供时为空。 |
| `engagement_rate` | 最近视频平均互动率：赞、评、分享之和除以播放量。 |
| `shop_signals` | Bio/视频文案中的 Shop 关键词命中数，仅作参考，不作为有效证明。 |
| `shop_valid` | 严格 Shop/Showcase 验证结果，布尔值。 |
| `shop_proof` | 跨来源统一值；合格行为 `shop_showcase_verified`。 |
| `shop_proof_method` | FastMoss 中的具体证据，例如达人橱窗开启状态或带 Shop 筛选的结果页。 |
| `email` | 达人公开展示并规范化后的联系邮箱。 |
| `email_source` | 邮箱发现位置，例如 `bio`、`profile`、`bio_url` 或 FastMoss 详情页。 |
| `email_verified` | 邮箱格式及域名 MX 检查结果；使用 `--skip-email-dns` 时只验证格式。 |
| `bio_url` | TikTok Bio 中的公开外链，例如 Linktree。 |
| `bio` | 抓取时的达人简介文本。 |
| `profile_url` | TikTok 公开主页。 |
| `source_url` | 支撑该行数据的来源页；FastMoss 通常为达人详情页。 |
| `fastmoss_units_sold` | FastMoss 销量；页面/导出未提供时为空。 |
| `fastmoss_gmv` | FastMoss GMV；页面/导出未提供时为空。 |
| `fastmoss_seller_id` | FastMoss 商家标识；未提供时为空。 |

---

## 联系方式获取逻辑

系统会自动从三个来源提取创作者联系方式：

1. **Bio 文本** — 正则提取 email
2. **TikHub `handler_user_profile`** — 获取 bio_url（linktr.ee 等外链）
3. **抓取 linktr.ee / lnk.bio 页面** — 提取 email 和 Instagram handle

结果写入 `final.csv` 的 `email`、`bio_url`、`instagram` 列。

---

## 项目文件说明

| 文件 | 说明 |
|------|------|
| `config.py` | 所有阈值和参数（**不含 Key**）|
| `search_keywords.py` | 60 个搜索关键词 |
| `models.py` | Creator / Video 数据类 |
| `tikhub_fetcher.py` | TikHub API 封装 |
| `social_fetcher.py` | TikHub Instagram / YouTube API 封装 |
| `feature_engine.py` | 40+ 特征计算 |
| `pipeline.py` | 三层筛选逻辑 |
| `demographics.py` | 评论区西方用户比例 |
| `claude_client.py` | Claude AI 相关性评分 |
| `output.py` | CSV 导出 |
| `main.py` | 主流程入口 |
| `fetch_creator_features.py` | 已知达人特征提取 |
| `mass_discovery.py` | FastMoss-only TTS 发现入口 |
| `kol_mcp_server.py` | 面向 AI Agent 的 MCP 工具入口与平台路由 |

## 离线验收

无需 API Key 即可验证完整漏斗和 CSV 导出：

```bash
.venv/bin/python main.py --mock
```

该命令使用本地固定样例，不会请求 TikHub、Claude 或创作者外链，输出到
`output/final.csv`。

## 本地 KOL MCP 服务

`kol_mcp_server.py` 将项目能力作为本地 stdio MCP 服务提供：FastMoss TTS 批量发现、
TikHub Instagram / YouTube 搜索与详情、非 TTS 的通用 TikTok 分析、联系方式补全、
特征/评分、全量筛选、多轮筛选、历史候选 CSV 排名、运行条件检查、结果读取与验收。

```bash
./run_mcp.sh
```

运行 `.venv/bin/python print_mcp_config.py` 会生成当前机器的绝对路径配置。等价结构如下：

```json
{
  "mcpServers": {
    "tiktok-kol-analyzer": {
      "command": "/absolute/path/to/tikhub-kol-analyzer/run_mcp.sh",
      "args": []
    }
  }
}
```

TTS 批处理使用 `run_shop_discovery`，数据源固定为 FastMoss，结果摘要中的
`tikhub_requests` 固定为 `0`。Instagram / YouTube 分别使用
`search_instagram_creators`、`get_instagram_creator`、`search_youtube_creators` 和
`get_youtube_creator`。

## 平台数据源路由

路由由代码固定，客户不需要也不能选择混合模式：

| 平台 | 唯一数据源 | MCP 工具 |
|------|------------|----------|
| TikTok Shop（TTS） | FastMoss 网页会话或导出文件 | `run_shop_discovery` |
| Instagram | TikHub Instagram V1 | `search_instagram_creators`、`get_instagram_creator` |
| YouTube | TikHub YouTube Web V2 | `search_youtube_creators`、`get_youtube_creator` |

TTS 的命令行运行方式如下，不再提供 `--mode` 或 TikHub 预算参数：

```bash
.venv/bin/python mass_discovery.py \
  --target 1000 --countries ES FR DE IT GB --resume
```

FastMoss 当前没有可用 API，本项目不会尝试调用 FastMoss OpenAPI。先初始化一次持久
网页登录；脚本会安全提示输入密码；
遇到验证码时在打开的浏览器中手动完成，再进入 Creator 搜索并设置五国、粉丝数和
有效 Shop/Showcase 筛选。确认结果页后在终端按回车保存登录态与筛选 URL：

```bash
bash fastmoss_browser_setup.sh
```

之后 TTS 流程会自动启动这个浏览器会话并逐页采集，绝不会调用 TikHub。密码不会落盘；
若登录态过期，再运行一次 setup 即可。

也可以把网页导出的 CSV/XLSX 直接交给
同一个自动回退入口。导出文件必须包含带货销量、GMV 或明确的 Showcase/带货有效
字段；没有电商证据的普通达人导出不会进入最终名单：

```bash
.venv/bin/python mass_discovery.py \
  --target 1000 \
  --fastmoss-export ~/Downloads/fastmoss-creators.xlsx \
  --countries ES FR DE IT GB --resume
```

若 FastMoss 没有可用候选，程序会立即停止并写出 `source_required.json`，不会自动切换
到 TikHub。FastMoss 密码不要写入仓库、命令行参数或日志。


---

## 阈值校准说明

所有 Step 1 / Step 2 阈值基于 **36 个历史合作效果较好的达人**（`output/creator_features_raw.csv`）的特征分布校准，取各指标 P05/P10 作为下限。回测召回率 **34/36（94%）**，2 人被正确过滤（舞蹈/变装，不符合业务方向）。

如需重新校准，运行 `fetch_creator_features.py` 提取新一批已知优质达人的特征，再手动对比 `config.py` 中的阈值。
