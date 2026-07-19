from __future__ import annotations

import unittest

from fastmoss_pipeline.scraper import (
    FastMossScraper,
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


class HarvestTests(unittest.TestCase):
    def test_harvest_keeps_email_target_separate_from_candidate_limit(self) -> None:
        class StubScraper(FastMossScraper):
            def __init__(self) -> None:
                pass

            def search(self, criteria, **kwargs):
                self.search_limit = kwargs["limit"]
                return {
                    "status": "complete",
                    "warnings": ["pages_visited=4; candidates_seen=3"],
                    "results": [
                        {"uid": "1", "username": "one", "email": ""},
                        {"uid": "2", "username": "two", "email": ""},
                        {"uid": "3", "username": "three", "email": ""},
                    ],
                }

            def enrich_emails(self, rows, **kwargs):
                self.email_target = kwargs["target_emails"]
                enriched = [dict(row) for row in rows]
                enriched[0]["email"] = "one@example.com"
                enriched[2]["email"] = "three@example.com"
                return {
                    "ok": True,
                    "status": "complete",
                    "candidate_count": len(rows),
                    "processed_count": len(rows),
                    "email_count": 2,
                    "warnings": [],
                    "results": enriched,
                }

        scraper = StubScraper()
        result = scraper.harvest(
            {"countries": ["FR"], "max_followers": 9_999},
            target_emails=2,
            candidate_limit=10,
        )
        self.assertEqual(scraper.search_limit, 10)
        self.assertEqual(scraper.email_target, 2)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["count"], 2)
        self.assertEqual([row["username"] for row in result["results"]], ["one", "three"])


if __name__ == "__main__":
    unittest.main()
