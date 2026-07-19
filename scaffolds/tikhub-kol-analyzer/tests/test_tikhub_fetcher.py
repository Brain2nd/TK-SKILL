from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from tikhub_pipeline.tikhub_fetcher import _get


class TikHubCredentialTests(unittest.TestCase):
    @patch("tikhub_pipeline.tikhub_fetcher.requests.get")
    def test_per_call_key_is_sent_only_in_authorization_header(self, request_get: Mock) -> None:
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"data": {}}
        request_get.return_value = response

        self.assertEqual(_get("/test", {"q": "creator"}, api_key="temporary-key"), {"data": {}})

        _, kwargs = request_get.call_args
        self.assertEqual(kwargs["headers"], {"Authorization": "Bearer temporary-key"})
        self.assertEqual(kwargs["params"], {"q": "creator"})


if __name__ == "__main__":
    unittest.main()
