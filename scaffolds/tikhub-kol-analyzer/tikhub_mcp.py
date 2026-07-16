"""Minimal Streamable-HTTP client for TikHub's TikTok MCP server.

Unlike the legacy REST wrapper, one instance keeps its MCP session open and
discovers tool names from ``tools/list``.  TikHub returns some responses as SSE,
so this client accepts both JSON and SSE JSON-RPC payloads.
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests


MCP_URL = os.environ.get("TIKHUB_MCP_URL", "https://mcp.tikhub.io/tiktok/mcp")


class TikHubMCPClient:
    def __init__(self, api_key: str | None = None, url: str = MCP_URL, timeout: int = 90):
        self.api_key = api_key or os.environ.get("TIKHUB_API_KEY", "")
        if not self.api_key:
            raise ValueError("TIKHUB_API_KEY is required for MCP mode")
        self.url = url
        self.timeout = timeout
        self.session_id: str | None = None
        self._request_id = 0
        self.http = requests.Session()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *_exc):
        self.http.close()

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        return headers

    @staticmethod
    def _decode_response(response: requests.Response) -> dict[str, Any]:
        """Return the last JSON-RPC payload from either JSON or an SSE body."""
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            return response.json()
        # TikHub may split a large ``tools/list`` JSON object across several
        # physical SSE data lines. Reassemble all data segments before decoding.
        # A stream can also contain multiple JSON-RPC events, hence raw_decode.
        data = "".join(line[5:].strip() for line in response.text.splitlines()
                       if line.startswith("data:"))
        payloads = []
        decoder = json.JSONDecoder()
        index = 0
        while index < len(data):
            start = data.find("{", index)
            if start < 0:
                break
            try:
                payload, end = decoder.raw_decode(data, start)
            except json.JSONDecodeError:
                # Some proxies emit one JSON value per event with no preserved
                # line boundary. The next object, if any, is still recoverable.
                index = start + 1
                continue
            payloads.append(payload)
            index = end
        if not payloads:
            raise RuntimeError("TikHub MCP returned no JSON-RPC payload")
        for payload in reversed(payloads):
            if "result" in payload or "error" in payload:
                return payload
        raise RuntimeError("TikHub MCP returned only notifications, not a response")

    def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self._request_id += 1
        response = self.http.post(
            self.url,
            headers=self._headers(),
            json={"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params},
            timeout=self.timeout,
        )
        payload = self._decode_response(response)
        if "error" in payload:
            raise RuntimeError(f"TikHub MCP {method} error: {payload['error']}")
        return payload["result"]

    def connect(self) -> None:
        """Initialize and retain the server session id."""
        self._request_id += 1
        response = self.http.post(self.url, headers=self._headers(), json={
            "jsonrpc": "2.0", "id": self._request_id, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "tikhub-kol-analyzer", "version": "1.0"}},
        }, timeout=self.timeout)
        self._decode_response(response)
        self.session_id = response.headers.get("Mcp-Session-Id")
        if not self.session_id:
            raise RuntimeError("TikHub MCP did not return Mcp-Session-Id")

    def tools(self) -> list[dict[str, Any]]:
        if not self.session_id:
            self.connect()
        tools = self._rpc("tools/list", {}).get("tools", [])
        if not tools:
            raise RuntimeError(
                "TikHub MCP returned an empty tool directory. Retry the request or "
                "use TikHub's current tool names with --search-tool, --videos-tool, "
                "and --country-tool."
            )
        return tools

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        if not self.session_id:
            self.connect()
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        blocks = result.get("content", [])
        text = "\n".join(block.get("text", "") for block in blocks if block.get("type") == "text")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return result

    @staticmethod
    def find_tool(tools: list[dict[str, Any]], *needles: str) -> str:
        """Find one tool whose name/description contains every requested term."""
        for tool in tools:
            searchable = f"{tool.get('name', '')} {tool.get('description', '')}".lower()
            if all(needle.lower() in searchable for needle in needles):
                return tool["name"]
        raise LookupError(f"No TikHub MCP tool matched: {', '.join(needles)}")
