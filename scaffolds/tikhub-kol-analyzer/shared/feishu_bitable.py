"""Feishu Base (Bitable) persistence for creator pipeline results.

The module intentionally uses only ``requests`` so both MCP servers and CLI
pipelines can share it. CSV remains a local audit artifact; when the Feishu
variables are configured, Base is the durable, queryable system of record.
"""
from __future__ import annotations

import csv
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import requests


API_ROOT = "https://open.feishu.cn/open-apis"
MAX_BATCH = 200


def _chunks(items: list[Any], size: int = MAX_BATCH) -> Iterable[list[Any]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


@dataclass(frozen=True)
class BitableConfig:
    app_id: str
    app_secret: str
    app_token: str
    table_id: str
    unique_field: str = "username"

    @classmethod
    def from_env(cls, *, required: bool = True) -> "BitableConfig | None":
        values = {
            "app_id": os.environ.get("FEISHU_APP_ID", "").strip(),
            "app_secret": os.environ.get("FEISHU_APP_SECRET", "").strip(),
            "app_token": os.environ.get("FEISHU_BITABLE_APP_TOKEN", "").strip(),
            "table_id": os.environ.get("FEISHU_BITABLE_TABLE_ID", "").strip(),
            "unique_field": os.environ.get("FEISHU_BITABLE_UNIQUE_FIELD", "username").strip(),
        }
        missing = [key for key in ("app_id", "app_secret", "app_token", "table_id") if not values[key]]
        if missing:
            if required:
                raise ValueError("Feishu Base is not configured; missing: " + ", ".join(missing))
            return None
        return cls(**values)


class FeishuBitable:
    def __init__(self, config: BitableConfig, timeout: int = 30):
        self.config = config
        self.timeout = timeout
        self.session = requests.Session()
        self._token = ""

    def _tenant_token(self) -> str:
        if self._token:
            return self._token
        response = self.session.post(
            f"{API_ROOT}/auth/v3/tenant_access_token/internal",
            json={"app_id": self.config.app_id, "app_secret": self.config.app_secret},
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            raise RuntimeError(f"Feishu authentication failed: {payload.get('msg', payload)}")
        self._token = payload["tenant_access_token"]
        return self._token

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        headers = dict(kwargs.pop("headers", {}))
        headers["Authorization"] = f"Bearer {self._tenant_token()}"
        response = self.session.request(
            method, f"{API_ROOT}{path}", headers=headers, timeout=self.timeout, **kwargs
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            raise RuntimeError(f"Feishu Base API failed ({payload.get('code')}): {payload.get('msg', payload)}")
        return payload.get("data") or {}

    @property
    def _table_path(self) -> str:
        return f"/bitable/v1/apps/{self.config.app_token}/tables/{self.config.table_id}"

    def list_fields(self) -> list[dict[str, Any]]:
        fields: list[dict[str, Any]] = []
        page_token = ""
        while True:
            params: dict[str, Any] = {"page_size": 100}
            if page_token:
                params["page_token"] = page_token
            data = self._request("GET", f"{self._table_path}/fields", params=params)
            fields.extend(data.get("items") or [])
            if not data.get("has_more"):
                return fields
            page_token = data.get("page_token", "")

    def ensure_text_fields(self, names: Iterable[str]) -> dict[str, dict[str, Any]]:
        existing = {field["field_name"]: field for field in self.list_fields()}
        for name in dict.fromkeys(str(item).strip() for item in names if str(item).strip()):
            if name in existing:
                continue
            data = self._request(
                "POST", f"{self._table_path}/fields",
                json={"field_name": name[:100], "type": 1},
            )
            field = data.get("field") or data
            existing[name] = field
        return existing

    @staticmethod
    def _inferred_field_type(values: Iterable[Any]) -> int:
        populated = [value for value in values if value not in (None, "")]
        if not populated:
            return 1
        lowered = {str(value).strip().lower() for value in populated}
        if lowered <= {"true", "false", "yes", "no", "1", "0"}:
            return 7
        try:
            for value in populated:
                float(str(value).replace(",", ""))
            return 2
        except (TypeError, ValueError):
            return 1

    def ensure_fields_for_rows(self, rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        existing = {field["field_name"]: field for field in self.list_fields()}
        columns = list(dict.fromkeys(key for row in rows for key in row))
        for name in columns:
            if name in existing:
                continue
            field_type = self._inferred_field_type(row.get(name) for row in rows)
            data = self._request(
                "POST", f"{self._table_path}/fields",
                json={"field_name": name[:100], "type": field_type},
            )
            existing[name] = data.get("field") or data
        return existing

    def list_records(self, field_names: list[str] | None = None) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        page_token = ""
        while True:
            params: dict[str, Any] = {"page_size": 500}
            if page_token:
                params["page_token"] = page_token
            body = {"field_names": field_names} if field_names else {}
            data = self._request("POST", f"{self._table_path}/records/search", params=params, json=body)
            records.extend(data.get("items") or [])
            if not data.get("has_more"):
                return records
            page_token = data.get("page_token", "")

    @staticmethod
    def _cell(value: Any, field_type: int) -> Any:
        if value is None:
            return None
        if field_type == 2:  # number
            try:
                return float(str(value).replace(",", ""))
            except (TypeError, ValueError):
                return None
        if field_type == 7:  # checkbox
            return str(value).strip().lower() in {"1", "true", "yes", "y"}
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        return str(value)[:100_000]

    def upsert(self, rows: list[dict[str, Any]], *, create_fields: bool = True) -> dict[str, Any]:
        if not rows:
            return {"created": 0, "updated": 0, "skipped": 0, "total": 0}
        fields = (
            self.ensure_fields_for_rows(rows)
            if create_fields else {f["field_name"]: f for f in self.list_fields()}
        )
        if self.config.unique_field not in fields:
            raise ValueError(f"unique field does not exist in Base: {self.config.unique_field}")
        remote = self.list_records([self.config.unique_field])
        by_key = {
            str(item.get("fields", {}).get(self.config.unique_field, "")).strip().lower(): item["record_id"]
            for item in remote
            if str(item.get("fields", {}).get(self.config.unique_field, "")).strip()
        }
        creates: list[dict[str, Any]] = []
        updates: list[dict[str, Any]] = []
        skipped = 0
        for row in rows:
            key = str(row.get(self.config.unique_field, "")).strip().lower()
            if not key:
                skipped += 1
                continue
            values = {
                name: self._cell(row.get(name), int(field.get("type", 1)))
                for name, field in fields.items()
                if name in row and row.get(name) not in (None, "")
            }
            if key in by_key:
                updates.append({"record_id": by_key[key], "fields": values})
            else:
                creates.append({"fields": values})
        for batch in _chunks(creates):
            self._request("POST", f"{self._table_path}/records/batch_create", json={"records": batch})
        for batch in _chunks(updates):
            self._request("POST", f"{self._table_path}/records/batch_update", json={"records": batch})
        return {"created": len(creates), "updated": len(updates), "skipped": skipped, "total": len(rows)}


def sync_rows(rows: list[dict[str, Any]], *, required: bool = True) -> dict[str, Any]:
    config = BitableConfig.from_env(required=required)
    if config is None:
        return {"configured": False, "created": 0, "updated": 0, "skipped": 0, "total": len(rows)}
    result = FeishuBitable(config).upsert(rows)
    return {"configured": True, "app_token": config.app_token, "table_id": config.table_id, **result}


def sync_csv(path: str | Path, *, required: bool = True) -> dict[str, Any]:
    source = Path(path).expanduser()
    if not source.exists():
        raise ValueError(f"CSV does not exist: {source}")
    with source.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {"source": str(source.resolve()), **sync_rows(rows, required=required)}


def auto_sync_csv(path: str | Path) -> dict[str, Any]:
    """Sync when configured; optionally fail the pipeline in strict mode."""
    strict = os.environ.get("FEISHU_BITABLE_STRICT", "").strip().lower() in {"1", "true", "yes"}
    try:
        return sync_csv(path, required=False)
    except Exception as exc:
        if strict:
            raise
        return {"configured": True, "synced": False, "error": str(exc), "source": str(path)}
