"""
Claude API client — Dogegoo KOL content relevance scoring.

score_creator(username, bio, video_descriptions) → dict with:
  relevance_score   : 0.0–1.0
  primary_category  : str
  reasoning         : str
"""
import json
import anthropic
from tikhub_pipeline.config import LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_PROVIDER


def _make_client() -> anthropic.Anthropic:
    """Create a Claude or DeepSeek Anthropic-compatible client."""
    kwargs = {"api_key": LLM_API_KEY}
    if LLM_BASE_URL:
        kwargs["base_url"] = LLM_BASE_URL
    return anthropic.Anthropic(**kwargs)


def score_creator(
    username: str,
    bio: str,
    video_descriptions: list[dict],
    client: anthropic.Anthropic | None = None,
) -> dict:
    """
    Returns {"relevance_score": float, "primary_category": str, "reasoning": str}.
    Falls back to {"relevance_score": 0.0, ...} on any parse/API error.
    """
    if client is None:
        client = _make_client()

    descriptions_text = "\n".join(
        f"- desc: {v.get('desc', '')} | tags: {', '.join(v.get('hashtags', []))}"
        for v in video_descriptions
    )

    prompt = f"""你是一个 TikTok 达人内容分析专家。请判断这位达人的内容与以下目标品类的相关程度。

目标品类（潮流穿搭 & 中国代购品类）：
- 设计师包袋开箱、购买分享、测评（Chanel、LV、Gucci、Prada、Dior 等）
- 平价仿款/Dupe 包袋开箱与测评（dhgate、aliexpress、taobao dupe）
- 奢侈品 Haul 内容（luxury haul、designer haul）
- 包袋收藏展示（bag collection、what's in my bag）
- 中国购物渠道买包/穿搭相关内容（taobao、shopping agent、rep bag、hoobuy、hubbuy、cssbuy、mulebuy 等）
- 潮流穿搭 Haul / Outfit 内容（streetwear、sneaker haul、fashion haul、OOTD）
- 中国代购平台开箱（从 1688、淘宝、DHgate、Hoobuy、Hubbuy 等购买的商品展示）
- 球鞋/配饰/服饰 Rep 开箱（rep sneakers、rep clothing、replica review）
- 高尔夫装备开箱、测评与平替推荐（budget golf clubs、golf club knockoff、replica golf clubs、golf equipment review、golf gear haul、squatch golf、cheap golf clubs、golf club alternative、golf starter set、affordable golf equipment、golf equipment budget）

达人信息：
- 用户名：{username}
- Bio：{bio}
- 最近10条视频描述和标签：
{descriptions_text}

请返回一个 JSON：
{{
  "relevance_score": 0.0-1.0 的浮点数,
  "primary_category": "最匹配的品类",
  "reasoning": "一句话理由"
}}

评分标准（覆盖所有目标品类）：

0.8-1.0：核心匹配 —— 内容主轴就是目标品类之一
  - 设计师包袋开箱/测评/收藏（Chanel/LV/Gucci/Hermès/Prada/Dior 等正品 haul、bag collection、"what's in my bag"）
  - 平价仿款/Dupe 包袋开箱测评（dhgate bag、taobao rep bag、aliexpress dupe bag）
  - 球鞋开箱/收藏/Rep 开箱/on-foot 测评（sneaker haul、rep sneakers、shoe collection）
  - 潮流穿搭 Haul / OOTD / 穿搭分享（streetwear、fashion haul、outfit）
  - 中国代购平台开箱（视频里出现 taobao、1688、DHgate、Hoobuy、Hubbuy、CSSBuy、Mulebuy、Sugargoo 等具体平台，代购商品不限品类）
  - 高尔夫装备开箱/测评/平替推荐（budget golf clubs、golf club knockoff、replica golf clubs、squatch golf clubs、golf gear haul、budget golf equipment、cheap golf clubs review、golf equipment dupe、golf club alternative）

0.6-0.8：强相关 —— 时尚/穿搭/包袋/球鞋为主，但形式或频率略偏
  - 时尚穿搭博主，主要做 outfit 分享但 haul/unboxing 不多
  - 偶尔出现 rep/dupe/中国购物渠道（非主线但有）
  - 配饰/首饰/眼镜等服饰周边收藏（与包袋穿搭强相关）
  - 奢侈品评价/对比/导购类内容（不一定有 haul）

0.4-0.6：弱相关 —— 沾边但非主线
  - 美妆 + 穿搭双线博主（穿搭仅作视频背景或穿插）
  - lifestyle vlog 偶尔晒包/晒穿搭/晒鞋
  - 测评博主涉及配饰/服饰但品类杂
  - 二手奢侈品/古着（vintage）/复古服饰

0.0-0.4：无关
  - 美食、旅行、健身、游戏、宠物、母婴、家居装修、汽车、科技数码
  - 纯美妆教程（无穿搭/包袋出镜）
  - 知识/教学/财经/政治

只返回 JSON，不要其他文字。"""

    try:
        response = client.messages.create(
            model=LLM_MODEL,
            max_tokens=600,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = ""
        for block in response.content:
            if hasattr(block, "text") and block.text:
                raw = block.text.strip()
                break

        if not raw:
            return {
                "relevance_score":  0.0,
                "primary_category": "error",
                "reasoning":        "scoring error: no text block in response",
            }

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        # Extract JSON object if surrounded by extra text
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        if start >= 0 and end > start:
            raw = raw[start:end]

        parsed = json.loads(raw)
        return {
            "relevance_score":  float(parsed.get("relevance_score", 0.0)),
            "primary_category": str(parsed.get("primary_category", "unknown")),
            "reasoning":        str(parsed.get("reasoning", "")),
        }

    except Exception as exc:
        return {
            "relevance_score":  0.0,
            "primary_category": "error",
            "reasoning":        f"scoring error: {exc}",
        }


def score_all_creators_dogegoo(
    candidates: list[dict],
    client: anthropic.Anthropic | None = None,
) -> None:
    """
    Scores each candidate dict in-place.
    Expects keys: username, bio, video_descriptions.
    Sets: ai_relevance_score, primary_category, ai_reasoning.
    """
    if client is None:
        client = _make_client()

    print(f"\n[{LLM_PROVIDER}] Scoring {len(candidates)} candidates for Dogegoo relevance...")
    for i, c in enumerate(candidates, 1):
        result = score_creator(
            c["username"],
            c.get("bio", ""),
            c.get("video_descriptions", []),
            client=client,
        )
        c["ai_relevance_score"] = result["relevance_score"]
        c["primary_category"]   = result["primary_category"]
        c["ai_reasoning"]       = result["reasoning"]
        print(f"  [{i}/{len(candidates)}] @{c['username']}: "
              f"{result['relevance_score']:.2f} ({result['primary_category']}) — {result['reasoning']}")
