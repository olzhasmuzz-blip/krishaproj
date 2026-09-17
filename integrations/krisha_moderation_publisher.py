"""Send a minimal signed Krisha moderation event to Estate Radar.

Call this only after the source system has committed its moderation transition.
Persist ``event_id`` in the source outbox before sending and reuse it for every
retry so the receiver can deduplicate deliveries.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


DEFAULT_TIMEOUT_SECONDS = 3.0
MAX_PAYLOAD_BYTES = 64 * 1024
EVENT_TYPE = "listing.submitted_for_moderation"
EVENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
LISTING_ID_PATTERN = re.compile(r"^\d{5,20}$")


class ModerationDeliveryError(RuntimeError):
    """The signed event could not be accepted by the Estate Radar receiver."""


def _text(value: Any, field: str, max_length: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    return " ".join(value.split())[:max_length]


def _number(value: Any, field: str, maximum: float, *, integer: bool = False) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    if (not isinstance(value, int) and not math.isfinite(value)) or value < 0 or value > maximum or (integer and not isinstance(value, int)):
        raise ValueError(f"{field} is outside the supported range")
    return value


def _utc_timestamp(value: str | datetime | None) -> str:
    if value is None:
        parsed = datetime.now(timezone.utc)
    elif isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("occurred_at must be an ISO-8601 timestamp") from error
    else:
        raise ValueError("occurred_at must be an ISO-8601 timestamp")
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("occurred_at must include a timezone")
    return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_moderation_event(
    *,
    event_id: str,
    listing: Mapping[str, Any],
    occurred_at: str | datetime | None = None,
) -> dict[str, Any]:
    """Build the receiver's version-1 payload, dropping every unapproved field."""
    if not isinstance(event_id, str) or not EVENT_ID_PATTERN.fullmatch(event_id):
        raise ValueError("event_id must contain 1-128 safe characters")
    if not isinstance(listing, Mapping):
        raise ValueError("listing must be a mapping")
    listing_id = listing.get("source_id", listing.get("id"))
    if isinstance(listing_id, bool) or listing_id is None:
        raise ValueError("listing.source_id must contain 5-20 digits")
    listing_id = str(listing_id)
    if not LISTING_ID_PATTERN.fullmatch(listing_id):
        raise ValueError("listing.source_id must contain 5-20 digits")

    price = _number(listing.get("price_kzt"), "price_kzt", 1_000_000_000_000)
    rooms = _number(listing.get("rooms"), "rooms", 100, integer=True)
    area = _number(listing.get("area_m2"), "area_m2", 1_000_000)
    return {
        "schema_version": 1,
        "event_id": event_id,
        "event_type": EVENT_TYPE,
        "occurred_at": _utc_timestamp(occurred_at),
        "listing": {
            "source_id": listing_id,
            "city": _text(listing.get("city"), "city", 100),
            "category": _text(listing.get("category"), "category", 80),
            "price_kzt": price,
            "rooms": rooms,
            "area_m2": area,
        },
    }


def sign_payload(payload: bytes, secret: str, timestamp: str) -> str:
    """Return the receiver-compatible HMAC-SHA256 header value."""
    if not isinstance(payload, bytes):
        raise TypeError("payload must be bytes")
    if not isinstance(secret, str) or len(secret) < 32:
        raise ValueError("KRISHA_MODERATION_WEBHOOK_SECRET must be at least 32 characters")
    if not re.fullmatch(r"\d{10}", timestamp):
        raise ValueError("timestamp must be Unix time in 10-digit seconds")
    digest = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + payload, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def send_moderation_event(
    event: Mapping[str, Any],
    *,
    endpoint: str | None = None,
    secret: str | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """POST a signed event; let the source's durable outbox own retries."""
    if not isinstance(event, Mapping):
        raise ValueError("event must be a mapping")
    event = build_moderation_event(
        event_id=event.get("event_id"),
        listing=event.get("listing"),
        occurred_at=event.get("occurred_at"),
    )
    endpoint = endpoint or os.environ.get("ESTATE_RADAR_MODERATION_WEBHOOK_URL", "")
    secret = secret or os.environ.get("KRISHA_MODERATION_WEBHOOK_SECRET", "")
    parsed_endpoint = urlsplit(endpoint)
    if parsed_endpoint.scheme != "https" or not parsed_endpoint.hostname or parsed_endpoint.username or parsed_endpoint.password:
        raise ValueError("ESTATE_RADAR_MODERATION_WEBHOOK_URL must be an HTTPS URL")
    if not isinstance(secret, str) or len(secret) < 32:
        raise ValueError("KRISHA_MODERATION_WEBHOOK_SECRET must be at least 32 characters")
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("timeout must be a positive number")

    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError("event payload exceeds the receiver's size limit")
    timestamp = str(int(time.time()))
    request = Request(
        endpoint,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Krisha-Timestamp": timestamp,
            "X-Krisha-Signature": sign_payload(payload, secret, timestamp),
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            if response.status != 202:
                raise ModerationDeliveryError(f"Estate Radar returned HTTP {response.status}")
            try:
                result = json.loads(response.read().decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ModerationDeliveryError("Estate Radar returned an invalid response") from error
            if not isinstance(result, dict) or result.get("accepted") is not True:
                raise ModerationDeliveryError("Estate Radar did not confirm event acceptance")
            return result
    except HTTPError as error:
        raise ModerationDeliveryError(f"Estate Radar returned HTTP {error.code}") from None
    except URLError as error:
        reason = "network error" if error.reason else "request failed"
        raise ModerationDeliveryError(f"Estate Radar webhook {reason}") from None

