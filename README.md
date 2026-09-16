# Estate Radar: production source adapter

Estate Radar is a separate Site from UkaLead. The dashboard, CRM board and Worker API are deployed as one product. The crawler uses ordinary BeautifulSoup parsing and posts normalized records to the Worker; D1 keeps objects, events, profiles, claims and the Telegram outbox.

Configure the Site secrets through the Sites environment settings:

- `KRISHA_SOURCE_MODE`: `api` for a JSON feed or `html` for a permitted HTML feed.
- `KRISHA_SOURCE_URL`: the approved endpoint or export URL.
- `KRISHA_SOURCE_TIMEOUT_MS`: optional request timeout, default `12000`.
- `INGEST_API_KEY`: shared secret for the crawler and write endpoints.
- `TELEGRAM_BOT_TOKEN`: Bot API token used by the scheduled outbox worker.

Run the local/scheduled poller with:

```bash
python -m crawler.poller --source-url "$KRISHA_SOURCE_URL" --api-url "$ESTATE_RADAR_API_URL" --api-key "$ESTATE_RADAR_API_KEY"
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

The Worker never bypasses CAPTCHA or challenge pages. Non-2xx responses, timeouts and malformed payloads become `source.status = error`; they do not archive existing records. `/api/ingest` performs idempotent upserts and creates `new`/`price` events; the scheduled handler drains the Telegram outbox with retry. Configure runtime secrets in Site, then create profiles with a Telegram chat ID through `/api/profiles`.

