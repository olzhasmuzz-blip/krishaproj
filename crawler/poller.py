"""BeautifulSoup polling bridge for scheduled production runs."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path

import httpx

from .krisha_parser import KrishaParser


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-url", default=os.environ.get("KRISHA_SOURCE_URL"))
    ap.add_argument("--api-url", default=os.environ.get("ESTATE_RADAR_API_URL"))
    ap.add_argument("--api-key", default=os.environ.get("ESTATE_RADAR_API_KEY"))
    ap.add_argument("--state", default=os.environ.get("ESTATE_RADAR_STATE", ".estate-radar/state.sqlite3"))
    args = ap.parse_args()
    if not args.source_url or not args.api_url or not args.api_key:
        ap.error("source-url, api-url and api-key are required (or set environment variables)")
    state_path = Path(args.state)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(state_path)
    con.execute("CREATE TABLE IF NOT EXISTS source_state (url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT)")
    row = con.execute("SELECT etag,last_modified FROM source_state WHERE url=?", (args.source_url,)).fetchone()
    parser = KrishaParser()
    try:
        listings, headers, status = parser.parse_search_url(args.source_url, etag=row[0] if row else None, last_modified=row[1] if row else None)
    finally:
        parser.close()
    if status == 304:
        return 0
    con.execute("INSERT INTO source_state(url,etag,last_modified) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified", (args.source_url, headers.get("etag"), headers.get("last-modified")))
    con.commit()
    response = httpx.post(args.api_url.rstrip("/") + "/api/ingest", json={"items": [listing.as_dict() for listing in listings]}, headers={"x-estate-radar-key": args.api_key}, timeout=20)
    response.raise_for_status()
    print(json.dumps({"parsed": len(listings), "ingest": response.json()}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

