# Estate Radar: production source adapter

Estate Radar is a separate Site from UkaLead. Krisha HTML is fetched and parsed by the Python BeautifulSoup crawler in a scheduled GitHub Action; the Site Worker only serves the normalized JSON feed and CRM API. Search segments are configured in `crawler/searches.json` and checked every 5 minutes. GitHub Actions may start scheduled jobs late under load, so this is a target cadence, not a real-time guarantee.

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

## Предмодерационные события Krisha

Обычный HTML-парсер обнаруживает объект после его появления в публичной выдаче. Для уведомления во время модерации Worker принимает серверное событие на отдельном маршруте:

```text
POST /api/integrations/krisha/moderation/events
```

Этот маршрут предназначен для push из внутреннего сервиса жизненного цикла объявлений Krisha при переходе объекта в `submitted_for_moderation`. Он проверяет HMAC-SHA256 подпись сырых байтов запроса. Заголовки: `X-Krisha-Timestamp` — Unix-время в секундах; `X-Krisha-Signature` — `sha256=<hex HMAC>`. Подписываемая строка: UTF-8 байты `<timestamp>.` затем исходные байты JSON. Принимаются запросы со временем подписи в пределах пяти минут; повторный `event_id` обрабатывается идемпотентно.

Пример тела:

```json
{
  "schema_version": 1,
  "event_id": "krisha-evt-unique-12345",
  "event_type": "listing.submitted_for_moderation",
  "occurred_at": "2026-09-17T06:00:00Z",
  "listing": {
    "source_id": "1012345678",
    "city": "Астана",
    "category": "Продажа квартир",
    "price_kzt": 45000000,
    "rooms": 2,
    "area_m2": 58
  }
}
```

Worker сохраняет ID события и объявления, время, город, категорию, цену, число комнат, площадь и SHA-256 нормализованного события. Он не сохраняет исходное тело, контакты, точный адрес, описание или фотографии. Предмодерационные события хранятся отдельно от публичных `/api/events` и `/api/ingest`; Telegram получает краткое уведомление без публичной ссылки. После успешной отправки содержимое Telegram outbox очищается. Не отправляйте в событии поля, которыми подписанные агентства не должны располагать.

Для включения интеграции:

1. Примените `migrations/0002_krisha_moderation_ingress.sql` к D1, связанному с Worker как `DB`.
2. Установите секреты Worker `KRISHA_MODERATION_WEBHOOK_SECRET` и `KRISHA_MODERATION_ADMIN_KEY` длиной не менее 32 символов каждый; не храните их в Git или клиентском JavaScript.
3. Убедитесь, что заданы `TELEGRAM_BOT_TOKEN` и `DB`.
4. Создайте фильтр агентства через закрытый административный маршрут `POST /api/integrations/krisha/moderation/subscriptions`, передав `Authorization: Bearer <KRISHA_MODERATION_ADMIN_KEY>`. Тело принимает `agency_name`, `telegram_chat_id` и необязательные фильтры `city`, `category`, `rooms_min`, `rooms_max`, `price_min_kzt`, `price_max_kzt`, `area_min_m2`, `area_max_m2`. Управление подписками доступно только с этим ключом.
5. В сервисе Krisha вызовите webhook после фиксации статуса модерации. События можно повторять после сетевого сбоя: повтор с тем же ID и содержимым не создаст повторную доставку.

Пока upstream-сервис Krisha не отправляет этот контракт, webhook остаётся закрытым и публичный монитор продолжает работать как раньше. Сейчас интеграция реализована на стороне Estate Radar; отправителя нужно подключить в сервисе, где фиксируется переход объявления на модерацию. В интерфейс публичной CRM предмодерационные записи не добавляются.
