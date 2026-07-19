"""
TikTok search keyword bank — Dogegoo KOL discovery.
Keywords are grouped by priority tier and used to search for
videos → extract unique creator IDs → build candidate pool.
"""

SEARCH_KEYWORDS = {
    "tier1_highest": [
        # cosplay haul + specific IPs (buying behaviour + vertically focused)
        "genshin cosplay haul", "genshin merch haul", "genshin costume review",
        "tgcf cosplay haul", "tgcf merch unboxing", "heaven official blessing cosplay",
        "mdzs cosplay haul", "mdzs merch collection", "wei wuxian cosplay review",
        "honkai star rail cosplay haul", "star rail merch haul",
        # taobao/chinese shopping (already buying from China — Dogegoo can step in)
        "taobao haul", "taobao cosplay haul", "chinese shopping haul",
        "how to buy from china anime", "shopping agent anime",
    ],
    "tier2_high": [
        # anime merch / itabag (high-frequency repeat buyers)
        "anime merch haul", "anime unboxing haul", "itabag collection", "itabag build",
        "blind box opening", "popmart unboxing", "anime photocard haul",
        # danmei / BL (highest female purchasing power)
        "danmei merch haul", "danmei cosplay haul", "bl anime merch haul",
        "wangxian cosplay haul", "hualian cosplay haul",
        # jfashion / lolita (validated by historical data)
        "jfashion haul", "lolita haul", "sweet lolita haul", "taobao lolita haul",
        "gothic lolita haul", "han lolita haul", "lolita dress from china",
    ],
    "tier3_medium": [
        # specific IP + merch/unboxing
        "demon slayer cosplay haul", "jjk cosplay haul", "gojo cosplay review",
        "spy x family cosplay haul", "frieren cosplay haul",
        "blue lock jersey haul", "one piece cosplay haul",
        "svsss cosplay haul", "link click cosplay haul", "nezha cosplay haul",
        # general cosplay buying-behaviour terms
        "cosplay haul", "cosplay on a budget", "affordable cosplay",
        "cosplay from china", "cosplay unboxing", "cosplay try on haul",
        "where I buy my cosplay", "cosplay shopping guide",
        # kawaii / pastel goth
        "kawaii outfit haul", "kawaii fashion haul", "kawaii from china",
        "pastel goth outfit haul", "fairy kei haul",
        "decora accessories haul", "gyaru fashion haul",
    ],
}
