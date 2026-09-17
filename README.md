# Estate Radar

Estate Radar is a separate product from UkaLead. It monitors public Krisha.kz search results with a Python crawler built on Requests and BeautifulSoup, stores a normalized feed, and can notify subscribed Telegram chats about newly found listings and price changes.

## Public listings

Searches are configured in `crawler/searches.json` and use Krisha's public `sort_by=add_date-desc` query to keep the newest listings first and reduce ranking rotation. GitHub Actions runs the poller on a five-minute schedule; Actions may start scheduled jobs late, so this is a target interval rather than a real-time guarantee. The first run establishes a baseline unless `--bootstrap-notifications` is supplied.

Run the poller locally:

```bash
python -m pip install -r crawler/requirements.txt
python -m crawler.poller --searches crawler/searches.json --output data/krisha-feed.json
```

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_IDS` as repository Actions secrets to enable public-listing alerts. CAPTCHA/challenge pages and HTTP 403/429 responses are reported as source failures; the crawler does not attempt to bypass them.

## Before-publication events

The public parser can only discover a listing after Krisha exposes it in public search. For a notification during moderation, the Krisha listing lifecycle service must emit `listing.submitted_for_moderation` after committing that state transition and deliver it from a durable outbox to the separate API-only receiver:

```text
https://estate-radar-ingress.iolzhik220366.chatgpt.site/api/integrations/krisha/moderation/events
```

The receiver verifies HMAC-SHA256, accepts an allowlist of listing fields, deduplicates retries, stores pending Telegram deliveries separately, and exposes no public listing catalog. The event publisher helper is `integrations/krisha_moderation_publisher.py`. Configure `ESTATE_RADAR_MODERATION_WEBHOOK_URL` and the shared `KRISHA_MODERATION_WEBHOOK_SECRET` in the Krisha source service. Keep `KRISHA_MODERATION_ADMIN_KEY` separate and only in the receiver's secret store.

The receiver is deployed and reachable, but the Krisha source service is not present in this repository. Production Telegram delivery for moderation events also requires the receiver's `TELEGRAM_BOT_TOKEN` and at least one agency subscription with a chat ID. Until the source publisher and a subscription are configured, no live pre-moderation alerts are delivered.

## Verification

```bash
npm test
python -m unittest integrations.test_krisha_moderation_publisher crawler.test_krisha_parser
```

