import hashlib
import hmac
import json
import math
import unittest
from datetime import datetime
from unittest.mock import patch

from integrations.krisha_moderation_publisher import (
    ModerationDeliveryError,
    build_moderation_event,
    send_moderation_event,
    sign_payload,
)


SECRET = "test-secret-for-estate-radar-webhook-32chars"
EVENT = build_moderation_event(
    event_id="krisha:submit:123456789:rev1",
    occurred_at="2026-09-17T12:30:00+06:00",
    listing={
        "source_id": "123456789",
        "city": " Алматы  ",
        "category": "Продажа квартир",
        "price_kzt": 45_000_000,
        "rooms": 2,
        "area_m2": 58.5,
        "address": "не должна попасть в payload",
        "phone": "+77000000000",
        "description": "не должно попасть в payload",
    },
)


class FakeResponse:
    def __init__(self, status=202, body=b'{"accepted":true,"deliveries_sent":1}'):
        self.status = status
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class ModerationPublisherTest(unittest.TestCase):
    def test_builds_minimal_receiver_contract_and_normalizes_time(self):
        self.assertEqual(EVENT["occurred_at"], "2026-09-17T06:30:00.000Z")
        self.assertEqual(EVENT["listing"]["city"], "Алматы")
        self.assertEqual(EVENT["listing"]["source_id"], "123456789")
        self.assertEqual(set(EVENT["listing"]), {"source_id", "city", "category", "price_kzt", "rooms", "area_m2"})
        self.assertEqual(EVENT["event_type"], "listing.submitted_for_moderation")

    def test_requires_stable_event_id_numeric_listing_id_and_timezone(self):
        with self.assertRaises(ValueError):
            build_moderation_event(event_id="bad id", listing={"source_id": "123456789"})
        with self.assertRaises(ValueError):
            build_moderation_event(event_id="event-1", listing={"source_id": "abc"})
        with self.assertRaises(ValueError):
            build_moderation_event(event_id="event-1", listing={"source_id": "123456789"}, occurred_at=datetime(2026, 9, 17))
        with self.assertRaises(ValueError):
            build_moderation_event(event_id="event-1", listing={"source_id": "123456789", "price_kzt": math.inf})

    def test_signs_exact_utf8_bytes_using_receiver_convention(self):
        payload = json.dumps(EVENT, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        timestamp = "1789641000"
        expected = "sha256=" + hmac.new(SECRET.encode(), timestamp.encode() + b"." + payload, hashlib.sha256).hexdigest()
        self.assertEqual(sign_payload(payload, SECRET, timestamp), expected)

    def test_sends_signed_event_and_accepts_202(self):
        with patch("integrations.krisha_moderation_publisher.urlopen", return_value=FakeResponse()) as opener:
            result = send_moderation_event(EVENT, endpoint="https://estate-radar.test/api/integrations/krisha/moderation/events", secret=SECRET)
        request = opener.call_args.args[0]
        headers = {name.lower(): value for name, value in request.header_items()}
        self.assertEqual(result["accepted"], True)
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["x-krisha-signature"], sign_payload(request.data, SECRET, headers["x-krisha-timestamp"]))
        self.assertNotIn(b"phone", request.data)
        self.assertNotIn(b"description", request.data)

    def test_rejects_missing_security_config_and_nonaccepted_responses(self):
        with self.assertRaises(ValueError):
            send_moderation_event(EVENT, endpoint="http://estate-radar.test/hook", secret=SECRET)
        with self.assertRaises(ValueError):
            send_moderation_event(EVENT, endpoint="https://estate-radar.test/hook", secret="short")
        with patch("integrations.krisha_moderation_publisher.urlopen", return_value=FakeResponse(status=503)):
            with self.assertRaises(ModerationDeliveryError):
                send_moderation_event(EVENT, endpoint="https://estate-radar.test/hook", secret=SECRET)


if __name__ == "__main__":
    unittest.main()

