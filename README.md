# Estate Radar: production source adapter

Estate Radar is a separate Site from UkaLead. The dashboard is already deployed and the Worker exposes a small source adapter contract so the licensed Krisha.kz feed can be connected without changing the UI.

Configure the Site secrets through the Sites environment settings:

- `KRISHA_SOURCE_MODE`: `api` for a JSON feed or `html` for a permitted HTML feed.
- `KRISHA_SOURCE_URL`: the approved endpoint or export URL.
- `KRISHA_SOURCE_TIMEOUT_MS`: optional request timeout, default `12000`.

For `api`, the response may be an array of listing objects or `{ "items": [...] }`. At minimum, each item should contain `source_id`, `url`, `title`; additional normalized fields are passed through to the event pipeline in the next backend slice.

For `html`, the adapter currently extracts links matching `/a/show/<id>` and their visible anchor text. A production parser should add a versioned extractor for the exact approved response shape, with contract fixtures, field-level provenance, and a quarantine path for markup changes.

The adapter returns:

```json
{
  "items": [{"source_id":"696148729","url":"https://krisha.kz/a/show/696148729","title":"..."}],
  "source": {"mode":"api","source":"krisha.kz","status":"healthy","count":1}
}
```

The Worker never bypasses CAPTCHA or challenge pages. Non-2xx responses, timeouts and malformed payloads become `source.status = error`; they do not archive existing records. Add Telegram credentials, outbox persistence, deduplication and scheduling as separate production capabilities after the source contract is verified.

