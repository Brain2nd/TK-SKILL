# Dogegoo TikTok KOL Filter

自动筛选 TikTok cosplay / jfashion / 动漫周边品类创作者，面向欧美 + 拉丁美洲市场。

---

## 环境准备

```bash
pip install -r requirements.txt

# 配置 API Key（复制模板后填入）
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY 和 TIKHUB_API_KEY
source .env
```

需要两个 API Key：
- **TIKHUB_API_KEY**：[api.tikhub.io](https://api.tikhub.io) — 所有 TikTok 数据拉取
- **ANTHROPIC_API_KEY**：Claude API — AI 相关性评分

---

## 快速开始

### 常规搜索（推荐）

```bash
python main.py --keyword "cosplay haul" --pages 15
```

输出到 `output/cosplay_haul/final.csv`，含排名、联系方式、评分详情。

### 多轮跨天搜索（扩大覆盖范围）

```bash
python multi_run_search.py --keyword "attack on titan haul" --runs 3 --interval 86400
```

TikTok 搜索池每天缓慢更新，间隔 24h 能覆盖更多创作者。短间隔（5min）新增极少，不推荐。

### 已知达人特征提取（用于阈值校准）

```bash
python fetch_creator_features.py --input /path/to/creators.xlsx
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

**注意：output/ 目录已加入 .gitignore，不会随代码提交。**

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
| `feature_engine.py` | 40+ 特征计算 |
| `pipeline.py` | 三层筛选逻辑 |
| `demographics.py` | 评论区西方用户比例 |
| `claude_client.py` | Claude AI 相关性评分 |
| `output.py` | CSV 导出 |
| `main.py` | 主流程入口 |
| `multi_run_search.py` | 多轮跨天搜索 |
| `fetch_creator_features.py` | 已知达人特征提取 |


---

## 阈值校准说明

所有 Step 1 / Step 2 阈值基于 **36 个历史合作效果较好的达人**（`output/creator_features_raw.csv`）的特征分布校准，取各指标 P05/P10 作为下限。回测召回率 **34/36（94%）**，2 人被正确过滤（舞蹈/变装，不符合业务方向）。

如需重新校准，运行 `fetch_creator_features.py` 提取新一批已知优质达人的特征，再手动对比 `config.py` 中的阈值。
