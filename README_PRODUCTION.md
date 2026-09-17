# Estate Radar: production source adapter

Estate Radar is a separate Site from UkaLead. Krisha HTML is fetched and parsed by the Python BeautifulSoup crawler in a scheduled GitHub Action; the Site Worker only serves the normalized JSON feed and CRM API. Search segments are configured in `crawler/searches.json` and run every 15 minutes.

Configure these repository Actions secrets to enable Telegram notifications:

- `TELEGRAM_BOT_TOKEN`: BotFather token for the notification bot.
- `TELEGRAM_CHAT_IDS`: comma-separated chat IDs to receive new listing and price-change alerts.

Run the same BeautifulSoup poller locally with:

```bash
python -m pip install -r crawler/requirements.txt
python -m crawler.poller --searches crawler/searches.json --output data/krisha-feed.json
```

For `api`, the response may be an array of listing objects or `{ "items": [...] }`. At minimum, each item should contain `source_id`, `url`, `title`; additional normalized fields are passed through to the event pipeline in the next backend slice.

For `html`, the adapter currently extracts links matching `/a/show/<id>` and their visible anchor text. A production parser should add a versioned extractor for the exact approved response shape, with contract fixtures, field-level provenance, and a quarantine path for markup changes.

The adapter returns:

```json
{
  "items": [{"source_id":"696148729","url":"https://krisha.kz/a/show/696148729","title":"..."}],
  "source": {"mode":"api","source":"krisha.kz","status":"healthy","count":1}
}
```

The crawler parses HTML with BeautifulSoup (`html.parser`); the Worker does not extract listing fields from source HTML. It keeps a feed snapshot, detects new IDs and price changes, and sends Telegram messages when the two notification secrets are configured. The first run creates a baseline without flooding the chat; later runs alert only on new listings or changed prices. CAPTCHA/challenge pages and HTTP 403/429 responses are reported as source failures without trying to bypass them.

