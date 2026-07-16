import unittest
from unittest.mock import patch

from contact_enrichment import enrich_contact, extract_email, extract_url


class ContactEnrichmentTest(unittest.TestCase):
    def test_extracts_and_normalizes_bio_email(self):
        self.assertEqual(
            extract_email("PR: Creator.Name+EU@Gmail.com."),
            "creator.name+eu@gmail.com",
        )

    def test_ignores_image_like_false_positive(self):
        self.assertEqual(extract_email("asset@cdn.example.png"), "")

    def test_finds_nested_profile_url(self):
        payload = {"user": {"bio_url": {"link_url": "https://linktr.ee/example"}}}
        self.assertEqual(extract_url(payload), "https://linktr.ee/example")

    def test_bio_source_wins_without_network(self):
        result = enrich_contact(
            {"bio": "Business: hello@example.com", "username": "creator"},
            verify_dns=False,
        )
        self.assertEqual(result["email"], "hello@example.com")
        self.assertEqual(result["email_source"], "bio")
        self.assertTrue(result["email_verified"])

    @patch("contact_enrichment.fetch_public_page", return_value="Contact collabs@example.org")
    def test_extracts_email_from_bio_url(self, _fetch):
        result = enrich_contact(
            {"bio": "", "bio_url": "https://linktr.ee/example"},
            verify_dns=False,
        )
        self.assertEqual(result["email"], "collabs@example.org")
        self.assertEqual(result["email_source"], "bio_url")


if __name__ == "__main__":
    unittest.main()
