"""Scheduled Krisha HTML ingestion. All listing extraction happens in BeautifulSoup."""
from __future__ import annotations

import argparse
import html
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .krisha_parser import KrishaListing, KrishaParser


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SEARCHES = ROOT / "crawler" / "searches.json"
DEFAULT_FEED = ROOT / "data" / "krisha-feed.json"


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _snapshot(listing: KrishaListing) -> dict[str, Any]:
    item = listing.as_dict()
    for key in ("raw_title", "parser_version", "provenance"):
        item.pop(key, None)
    item["photo_urls"] = item.get("photo_urls", [])[:3]
    return item


def _send_telegram(token: str, chat_ids: list[str], events: list[dict[str, Any]]) -> int:
    if not token or not chat_ids or not events:
        return 0
    sent = 0
    with httpx.Client(timeout=15) as client:
        for event in events:
            label = "🆕 Новый объект" if event["event_type"] == "new" else "📉 Изменение цены"
            title = html.escape(str(event.get("title") or "Объект"))
            address = html.escape(str(event.get("address") or event.get("city") or "Адрес не указан"))
            price = f"{int(event['price_kzt']):,}".replace(",", " ") + " ₸" if event.get("price_kzt") else "цена не указана"
            text = f"{label}\n<b>{title}</b>\n{address}\n{price}\n<a href=\"{html.escape(event['url'], quote=True)}\">Открыть объявление</a>"
            for chat_id in chat_ids:
                response = client.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": False},
                )
                response.raise_for_status()
                if not response.json().get("ok"):
                    raise RuntimeError("Telegram Bot API rejected sendMessage")
                sent += 1
    return sent


def _event(item: dict[str, Any], kind: str, previous: int | None, observed: str) -> dict[str, Any]:
    return {"event_id": f"{item['source_id']}:{kind}:{observed}", "source_id": item["source_id"], "event_type": kind,
            "previous_price_kzt": previous, "observed_at": observed, "title": item.get("title"),
            "address": item.get("address"), "city": item.get("city"), "price_kzt": item.get("price_kzt"), "url": item["url"]}


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch configured Krisha search pages and parse them with BeautifulSoup.")
    ap.add_argument("--searches", default=os.environ.get("KRISHA_SEARCHES_FILE", str(DEFAULT_SEARCHES)))
    ap.add_argument("--source-url", action="append", default=[], help="Additional search URL; may be repeated")
    ap.add_argument("--output", default=os.environ.get("KRISHA_FEED_FILE", str(DEFAULT_FEED)))
    ap.add_argument("--state", default=os.environ.get("KRISHA_STATE_FILE", ".estate-radar/state.sqlite3"))
    ap.add_argument("--telegram-token", default=os.environ.get("TELEGRAM_BOT_TOKEN", ""))
    ap.add_argument("--telegram-chat-ids", default=os.environ.get("TELEGRAM_CHAT_IDS", ""))
    ap.add_argument("--bootstrap-notifications", action="store_true", help="Notify about existing listings on first run")
    args = ap.parse_args()

    searches_doc = _read_json(Path(args.searches), {"urls": []})
    urls = list(dict.fromkeys([*searches_doc.get("urls", []), *args.source_url]))
    if not urls:
        ap.error("No search URLs configured in searches.json or --source-url")

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    old_feed = _read_json(output_path, {})
    old_items = {str(item.get("source_id")): item for item in old_feed.get("items", []) if item.get("source_id")}
    is_bootstrap = not bool(old_feed.get("items"))
    observed_at = datetime.now(timezone.utc).isoformat()

    state_path = Path(args.state)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(state_path)
    con.execute("CREATE TABLE IF NOT EXISTS source_state (url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, checked_at TEXT NOT NULL)")
    parser = KrishaParser(min_interval_s=float(searches_doc.get("minimum_request_interval_seconds", 2)))
    current: dict[str, KrishaListing] = {}
    query_by_id: dict[str, str] = {}
    failures: list[str] = []
    try:
        for url in urls:
            row = con.execute("SELECT etag,last_modified FROM source_state WHERE url=?", (url,)).fetchone()
            try:
                listings, headers, status = parser.parse_search_url(url, etag=row[0] if row else None, last_modified=row[1] if row else None)
                con.execute("INSERT INTO source_state(url,etag,last_modified,checked_at) VALUES(?,?,?,?) ON CONFLICT(url) DO UPDATE SET etag=excluded.etag,last_modified=excluded.last_modified,checked_at=excluded.checked_at",
                            (url, headers.get("etag"), headers.get("last-modified"), observed_at))
                for listing in listings:
                    item = _snapshot(listing)
                    item["query_url"] = url
                    current[item["source_id"]] = listing
                    query_by_id[item["source_id"]] = url
            except Exception as exc:  # keep other configured search segments healthy
                failures.append(f"{url}: {type(exc).__name__}: {exc}")
    finally:
        parser.close()
    con.commit()
    con.close()

    if not current and failures and not old_items:
        raise RuntimeError("All configured searches failed: " + "; ".join(failures))

    events = list(old_feed.get("events", []))
    items_out: list[dict[str, Any]] = []
    new_events: list[dict[str, Any]] = []
    for source_id, listing in current.items():
        item = _snapshot(listing)
        item["query_url"] = query_by_id.get(source_id, "")
        previous = old_items.get(source_id)
        previous_price = previous.get("price_kzt") if previous else None
        kind = None
        if previous is None and (not is_bootstrap or args.bootstrap_notifications):
            kind = "new"
        elif previous is not None and previous_price and item.get("price_kzt") and int(previous_price) != int(item["price_kzt"]):
            kind = "price"
        if kind:
            created = _event(item, kind, int(previous_price) if previous_price else None, observed_at)
            events.insert(0, created)
            new_events.append(created)
        latest_event = next((event for event in events if str(event.get("source_id")) == source_id), None)
        recent_cutoff = datetime.now(timezone.utc).timestamp() - 24 * 60 * 60
        recent_event = False
        if latest_event:
            try:
                recent_event = datetime.fromisoformat(latest_event["observed_at"].replace("Z", "+00:00")).timestamp() >= recent_cutoff
            except (KeyError, ValueError):
                pass
        item["event_type"] = latest_event["event_type"] if recent_event else "existing"
        item["first_seen_at"] = previous.get("first_seen_at") if previous else observed_at
        item["last_seen_at"] = observed_at if kind or not previous else previous.get("last_seen_at", observed_at)
        item["observed_at"] = latest_event.get("observed_at") if recent_event else item["first_seen_at"]
        items_out.append(item)

    failed_urls = {failure.split(": ", 1)[0] for failure in failures}
    current_ids = {item.get("source_id") for item in items_out}
    for old in old_items.values():
        if old.get("query_url") in failed_urls and old.get("source_id") not in current_ids:
            items_out.append(old)
    items_out.sort(key=lambda item: (0 if item.get("event_type") in {"new", "price"} else 1, -datetime.fromisoformat(item.get("observed_at", observed_at).replace("Z", "+00:00")).timestamp()))
    events = events[:300]
    def content_signature(rows: list[dict[str, Any]]) -> dict[str, tuple[Any, ...]]:
        fields = ("title", "description", "price_kzt", "rooms", "area_m2", "floor", "floors_total", "address", "city")
        return {str(row["source_id"]): tuple(row.get(field) for field in fields) for row in rows if row.get("source_id")}

    unchanged = bool(old_feed.get("items")) and content_signature(old_feed.get("items", [])) == content_signature(items_out)
    feed = {"source": "krisha.kz", "parser": "BeautifulSoup/html.parser", "parser_version": "krisha-bs4-1.1.0",
            "status": "healthy" if not failures else "partial", "updated_at": old_feed.get("updated_at") if unchanged else observed_at,
            "checked_at": observed_at, "poll_interval_minutes": int(searches_doc.get("poll_interval_minutes", 5)), "checked_urls": urls,
            "failed_urls": failures, "bootstrap": is_bootstrap, "count": len(items_out), "items": items_out, "events": events}
    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")
    temp_path.write_text(json.dumps(feed, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temp_path.replace(output_path)

    chat_ids = [value.strip() for value in args.telegram_chat_ids.split(",") if value.strip()]
    sent = _send_telegram(args.telegram_token, chat_ids, new_events)
    print(json.dumps({"parser": "BeautifulSoup", "checked_urls": len(urls), "parsed": len(items_out), "new_events": len(new_events),
                      "telegram_sent": sent, "bootstrap": is_bootstrap, "failures": failures}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
