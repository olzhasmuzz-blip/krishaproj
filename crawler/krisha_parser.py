from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup, Tag


LISTING_ID_RE = re.compile(r"/a/show/(\d+)")
PRICE_RE = re.compile(r"([\d\s\u00a0]+)\s*(?:₸|тг)", re.I)
AREA_RE = re.compile(r"([\d]+(?:[.,][\d]+)?)\s*(?:м²|м2)", re.I)
ROOM_RE = re.compile(r"(\d+)\s*-?комн", re.I)
FLOOR_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def _clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()


def _number(value: str | None) -> int | float | None:
    if not value:
        return None
    raw = re.sub(r"[^\d,.]", "", value).replace(" ", "")
    if not raw:
        return None
    try:
        return float(raw.replace(",", ".")) if "." in raw or "," in raw else int(raw)
    except ValueError:
        return None


def _first_text(node: Tag | BeautifulSoup, selectors: Iterable[str]) -> str:
    for selector in selectors:
        found = node.select_one(selector)
        if found:
            text = _clean(found.get_text(" ", strip=True))
            if text:
                return text
    return ""


def _json_ld(soup: BeautifulSoup) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            parsed = json.loads(script.string or script.get_text())
        except (TypeError, json.JSONDecodeError):
            continue
        values = parsed if isinstance(parsed, list) else [parsed]
        records.extend(item for item in values if isinstance(item, dict))
    return records


@dataclass(slots=True)
class KrishaListing:
    source: str = "krisha.kz"
    source_id: str = ""
    url: str = ""
    title: str = ""
    description: str = ""
    price_kzt: int | None = None
    rooms: int | None = None
    area_m2: float | None = None
    floor: int | None = None
    floors_total: int | None = None
    address: str = ""
    city: str = ""
    district: str = ""
    residential_complex: str = ""
    condition: str = ""
    seller_label: str = ""
    photo_urls: list[str] = field(default_factory=list)
    first_seen_at: str = ""
    raw_title: str = ""
    parser_version: str = "krisha-bs4-1.1.0"
    provenance: dict[str, str] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class KrishaParser:
    """Conservative parser for an approved Krisha.kz HTML feed.

    It only parses responses supplied by the configured source URL. The parser
    does not attempt to solve CAPTCHA, emulate a browser, or bypass access controls.
    """

    def __init__(self, *, base_url: str = "https://krisha.kz", min_interval_s: float = 2.0,
                 timeout_s: float = 15.0, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.min_interval_s = max(0.0, min_interval_s)
        self.timeout_s = timeout_s
        self._last_request = 0.0
        self.client = client or httpx.Client(
            timeout=httpx.Timeout(timeout_s),
            follow_redirects=True,
            headers={
                "User-Agent": "EstateRadar/1.0 (+authorized source adapter)",
                "Accept-Language": "ru,en;q=0.7",
            },
        )

    def close(self) -> None:
        self.client.close()

    def fetch(self, url: str, *, etag: str | None = None, last_modified: str | None = None) -> tuple[str, dict[str, str], int]:
        wait = self.min_interval_s - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        headers: dict[str, str] = {}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        response = self.client.get(url, headers=headers)
        self._last_request = time.monotonic()
        content_type = response.headers.get("content-type", "")
        if response.status_code == 304:
            return "", dict(response.headers), 304
        if response.status_code in {403, 429}:
            raise RuntimeError(f"source_access_limited:{response.status_code}")
        if response.status_code >= 400:
            raise RuntimeError(f"source_http_error:{response.status_code}")
        if "html" not in content_type.lower():
            raise RuntimeError(f"unexpected_content_type:{content_type}")
        return response.text, dict(response.headers), response.status_code

    def parse_search_page(self, html: str, *, page_url: str | None = None, observed_at: datetime | None = None) -> list[KrishaListing]:
        soup = BeautifulSoup(html, "html.parser")
        page_url = page_url or self.base_url
        observed = (observed_at or datetime.now(timezone.utc)).isoformat()
        result: list[KrishaListing] = []
        seen: set[str] = set()
        listing_cards = soup.select(".a-card[data-id]")
        anchors = (
            (card, anchor)
            for card in listing_cards
            for anchor in card.select('a[href*="/a/show/"]')
        ) if listing_cards else (
            (None, anchor) for anchor in soup.select('a[href*="/a/show/"]')
        )
        for card, anchor in anchors:
            href = str(anchor.get("href") or "")
            match = LISTING_ID_RE.search(href)
            if not match or match.group(1) in seen:
                continue
            seen.add(match.group(1))
            if card is None:
                card = next((parent for parent in anchor.parents if isinstance(parent, Tag) and "a-card" in (parent.get("class") or [])), anchor)
            if card is anchor:
                for parent in anchor.parents:
                    if isinstance(parent, Tag) and parent.select_one('[data-testid*="price"], .a-card__price, .a-card__main-info'):
                        card = parent
                        break
                    if parent.name in {"body", "html"}:
                        break
            text = _clean(card.get_text(" ", strip=True))
            title = _first_text(card, ["[data-testid='listing-title']", ".a-card__title", ".a-card__header h2", ".a-card__header h3", "h2", "h3"]) or _clean(anchor.get("title") or anchor.get_text(" ", strip=True))
            listing = KrishaListing(source_id=match.group(1), url=urljoin(page_url, href), title=title, raw_title=title, first_seen_at=observed)
            listing.price_kzt = self._extract_price(card, text)
            listing.rooms = self._extract_rooms(card, text)
            listing.area_m2 = self._extract_area(card, text)
            listing.floor, listing.floors_total = self._extract_floor(card, text)
            listing.address = _first_text(card, ["[data-testid='listing-address']", ".a-card__address", ".a-card__subtitle"])
            listing.description = _first_text(card, ["[data-testid='description']", ".a-card__text-preview"])
            listing.city = _first_text(card, ["[data-testid='listing-city']", ".a-card__stats-item"])
            listing.district = self._extract_district(listing.address)
            listing.residential_complex = _first_text(card, ["[data-testid='residential-complex']", ".a-card__complex"])
            listing.seller_label = _first_text(card, ["[data-testid='seller-type']", ".a-card__owner-label", ".a-card__user-type"])
            listing.photo_urls = self._extract_photos(card, page_url)
            listing.provenance = {"title": "search_html", "price_kzt": "search_html", "address": "search_html"}
            if "krisha.kz" in page_url and not listing.city:
                city_match = re.search(r"/([a-z-]+)/?$", page_url.rstrip("/") + "/", re.I)
                if city_match:
                    listing.city = {"almaty": "Алматы", "astana": "Астана", "nur-sultan": "Астана"}.get(city_match.group(1), city_match.group(1))
            result.append(listing)
        return result

    def parse_detail_page(self, html: str, *, listing_url: str, observed_at: datetime | None = None) -> KrishaListing:
        soup = BeautifulSoup(html, "html.parser")
        match = LISTING_ID_RE.search(listing_url)
        listing = KrishaListing(source_id=match.group(1) if match else "", url=listing_url, first_seen_at=(observed_at or datetime.now(timezone.utc)).isoformat())
        ld = next((item for item in _json_ld(soup) if item.get("@type") in {"Product", "Offer", "Apartment", "Residence"}), {})
        listing.title = _first_text(soup, ["h1", "[data-testid='listing-title']", ".offer__title"]) or _clean(ld.get("name"))
        listing.raw_title = listing.title
        listing.description = _first_text(soup, ["[data-testid='description']", ".offer__description", "meta[name='description']"]) or _clean(ld.get("description"))
        page_text = _clean(soup.get_text(" ", strip=True))
        listing.price_kzt = self._extract_price(soup, page_text) or _number(str((ld.get("offers") or {}).get("price", "")))
        listing.rooms = self._extract_rooms(soup, page_text)
        listing.area_m2 = self._extract_area(soup, page_text)
        listing.floor, listing.floors_total = self._extract_floor(soup, page_text)
        listing.address = _first_text(soup, ["[data-testid='address']", ".offer__address", "meta[property='og:street-address']"])
        listing.city = _first_text(soup, ["[data-testid='city']", ".offer__location-city"])
        listing.residential_complex = _first_text(soup, ["[data-testid='residential-complex']", ".offer__complex"])
        listing.condition = _first_text(soup, ["[data-testid='condition']", ".offer__parameters"])
        listing.seller_label = _first_text(soup, ["[data-testid='seller-type']", ".offer__owner-type"])
        listing.photo_urls = [urljoin(listing_url, str(img.get("src") or img.get("data-src"))) for img in soup.select("img[src], img[data-src]") if img.get("src") or img.get("data-src")]
        listing.provenance = {"title": "detail_html_or_jsonld", "description": "detail_html_or_jsonld", "price_kzt": "detail_html_or_jsonld"}
        return listing

    @staticmethod
    def _extract_price(node: Tag | BeautifulSoup, text: str) -> int | None:
        found = _first_text(node, ["[data-testid*='price']", ".a-card__price", ".offer__price", ".price"])
        match = PRICE_RE.search(found or text)
        return int(_number(match.group(1)) or 0) or None if match else None

    @staticmethod
    def _extract_rooms(node: Tag | BeautifulSoup, text: str) -> int | None:
        match = ROOM_RE.search(_first_text(node, ["[data-testid*='rooms']", ".a-card__main-info", ".offer__parameters"]) or text)
        return int(match.group(1)) if match else None

    @staticmethod
    def _extract_area(node: Tag | BeautifulSoup, text: str) -> float | None:
        match = AREA_RE.search(_first_text(node, ["[data-testid*='area']", ".a-card__main-info", ".offer__parameters"]) or text)
        return float(_number(match.group(1)) or 0) or None if match else None

    @staticmethod
    def _extract_floor(node: Tag | BeautifulSoup, text: str) -> tuple[int | None, int | None]:
        match = FLOOR_RE.search(_first_text(node, ["[data-testid*='floor']", ".a-card__main-info", ".offer__parameters"]) or text)
        return (int(match.group(1)), int(match.group(2))) if match else (None, None)

    @staticmethod
    def _extract_district(address: str) -> str:
        match = re.search(r"([^,]+(?:р-н|район))", address, re.I)
        return _clean(match.group(1)) if match else ""

    @staticmethod
    def _extract_photos(card: Tag | BeautifulSoup, page_url: str) -> list[str]:
        urls: list[str] = []
        for picture in card.select("picture"):
            if picture.get("data-full-src"):
                urls.append(urljoin(page_url, str(picture["data-full-src"])))
            for source in picture.select("source[srcset]"):
                candidate = str(source.get("srcset") or "").split(",", 1)[0].strip().split(" ", 1)[0]
                if candidate:
                    urls.append(urljoin(page_url, candidate))
        for image in card.select("img[src], img[data-src]"):
            candidate = image.get("data-src") or image.get("src")
            if candidate:
                urls.append(urljoin(page_url, str(candidate)))
        return list(dict.fromkeys(url for url in urls if "tooltip" not in url))[:12]

    def parse_search_url(self, url: str, *, etag: str | None = None, last_modified: str | None = None) -> tuple[list[KrishaListing], dict[str, str], int]:
        html, headers, status = self.fetch(url, etag=etag, last_modified=last_modified)
        if status == 304:
            return [], headers, status
        return self.parse_search_page(html, page_url=url), headers, status


def dumps(listings: list[KrishaListing]) -> str:
    return json.dumps([item.as_dict() for item in listings], ensure_ascii=False, indent=2)

