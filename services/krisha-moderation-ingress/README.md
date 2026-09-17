# Estate Radar Secure Ingress

Минимальный публичный Worker для получения только серверных событий Krisha о переводе объявления на модерацию. Он не содержит интерфейса CRM, общего каталога объектов или публичного чтения записей.

## Маршруты

- `GET /api/health` — короткая проверка доступности.
- `POST /api/integrations/krisha/moderation/events` — приём JSON, подписанного HMAC-SHA256.
- `GET|POST /api/integrations/krisha/moderation/subscriptions` и `DELETE /api/integrations/krisha/moderation/subscriptions/{uuid}` — управление Telegram-фильтрами с закрытым Bearer-ключом.

Любой другой путь отвечает `404`; CORS и выдачи объявлений нет.

## Подпись и повторная доставка

`X-Krisha-Timestamp` содержит Unix-время в секундах, а `X-Krisha-Signature` — `sha256=<hex>`. Подписывается точная последовательность байтов `<timestamp>.` + исходное тело запроса. Принимается временной интервал до пяти минут. Секрет должен содержать не менее 32 символов.

Идентификатор `event_id` должен быть постоянным для исходного перехода статуса и повторно использоваться при сетевой ошибке. Worker сохраняет нормализованный минимум в D1, отбрасывая поля вне allowlist. `202` означает, что событие сохранено и все уведомления по совпавшим фильтрам доставлены либо активных фильтров нет. Пока не создано ни одной подписки, обработчик вернёт `503`, чтобы отправитель продолжал хранить событие и повторил его позже. Если Telegram временно недоступен, запись остаётся в outbox, а Worker возвращает `503` для повторной отправки того же event из durable outbox источника. Повтор с тем же `event_id` не создаёт вторую карточку уведомления.

Разрешённые поля: `event_id`, `event_type`, `occurred_at`, `listing.source_id`, `listing.city`, `listing.category`, `listing.price_kzt`, `listing.rooms`, `listing.area_m2`. Контакты, точный адрес, описание и фотографии не сохраняются и не отправляются.

## Производственные секреты

В настройках Worker задать:

- `KRISHA_MODERATION_WEBHOOK_SECRET` — общий HMAC-секрет отправителя и приёмника;
- `KRISHA_MODERATION_ADMIN_KEY` — отдельный ключ управления подписками;
- `TELEGRAM_BOT_TOKEN` — токен Telegram-бота.

Пустые секреты не открывают маршрут: обработчик завершает запрос отказом. Значения среды размещения задаются через Sites runtime settings; файлы проекта содержат только пустые шаблоны.

Подписка создаётся администратором на `POST /api/integrations/krisha/moderation/subscriptions`:

```json
{
  "agency_name": "North Realty",
  "telegram_chat_id": "-1001234567890",
  "city": "Астана",
  "category": "Продажа квартир",
  "rooms_min": 1,
  "rooms_max": 3,
  "price_max_kzt": 70000000
}
```

Админ-ответ не раскрывает Telegram chat ID. Схема D1 находится в `drizzle/0001_moderation_ingress.sql`.

## Отправитель Krisha

Подключить SDK `integrations/krisha_moderation_publisher.py` из Estate Radar репозитория нужно после фиксации перехода на `submitted_for_moderation`: сначала записать outbox событие со стабильным ID, затем выполнить подписанную HTTPS-отправку. В source-сервисе настроить `ESTATE_RADAR_MODERATION_WEBHOOK_URL` на `/api/integrations/krisha/moderation/events` и тот же HMAC-секрет. Сам источник Krisha не входит в этот репозиторий, поэтому публикация Worker сама по себе не создаёт новые события.

## Проверка

`npm test` собирает Cloudflare Worker и запускает тесты подписи, allowlist полей, повторной доставки, закрытого администрирования, лимита тела и отсутствия публичного каталога.

