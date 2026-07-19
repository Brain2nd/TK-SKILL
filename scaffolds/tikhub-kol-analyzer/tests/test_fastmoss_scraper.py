from __future__ import annotations

import unittest

from fastmoss_pipeline.scraper import (
    SearchCriteria,
    matches_criteria,
    normalize_record,
    parse_number,
    records_from_payload,
)


class NumberParsingTests(unittest.TestCase):
    def test_compact_units(self) -> None:
        self.assertEqual(parse_number("1.2K"), 1_200)
        self.assertEqual(parse_number("3.5万"), 35_000)
        self.assertEqual(parse_number("€2.4M"), 2_400_000)


class CriteriaTests(unittest.TestCase):
    def test_aliases_and_country_normalization(self) -> None:
        criteria = SearchCriteria.from_dict({
            "query": "beauty",
            "country": "es",
            "followers_max": 10_000,
        })
        self.assertEqual(criteria.keyword, "beauty")
        self.assertEqual(criteria.countries, ["ES"])
        self.assertEqual(criteria.max_followers, 10_000)

    def test_invalid_range(self) -> None:
        with self.assertRaises(ValueError):
            SearchCriteria.from_dict({"min_followers": 20, "max_followers": 10})

    def test_normalizes_bulk_keywords(self) -> None:
        criteria = SearchCriteria.from_dict({"keywords": [" belleza ", "hogar", "belleza"]})
        self.assertEqual(criteria.keywords, ["belleza", "hogar"])


class RecordTests(unittest.TestCase):
    def test_normalizes_nested_api_record(self) -> None:
        row = normalize_record({
            "author": {
                "unique_id": "@Creator.One",
                "follower_count": "8.5K",
                "region": "es",
            },
            "metrics": {"avg_views": "12K", "gmv": "$4.2K"},
        })
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["username"], "creator.one")
        self.assertEqual(row["followers"], 8_500)
        self.assertEqual(row["avg_views"], 12_000)
        self.assertEqual(row["country"], "ES")

    def test_finds_records_in_changed_envelope(self) -> None:
        payload = {"data": {"result": {"items": [
            {"unique_id": "one", "follower_count": 900, "region": "GB"},
            {"unique_id": "two", "follower_count": 1_200, "region": "FR"},
        ]}}}
        rows = records_from_payload(payload)
        self.assertEqual({row["username"] for row in rows}, {"one", "two"})

    def test_client_side_filters_are_strict(self) -> None:
        criteria = SearchCriteria.from_dict({
            "countries": ["ES"],
            "min_followers": 1_000,
            "max_followers": 10_000,
            "min_avg_views": 2_000,
            "keyword": "beauty",
        })
        self.assertTrue(matches_criteria({
            "country": "ES", "followers": 4_000, "avg_views": 8_000,
            "bio": "Beauty reviews",
        }, criteria))
        self.assertFalse(matches_criteria({
            "country": "ES", "followers": 40_000, "avg_views": 8_000,
            "bio": "Beauty reviews",
        }, criteria))


if __name__ == "__main__":
    unittest.main()
