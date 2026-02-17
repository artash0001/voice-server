# Voice Server — Twilio ↔ ElevenLabs

Сервер для голосовых звонков с AI через Twilio и ElevenLabs Conversational API.

## Архитектура

```
Телефон → Twilio → Render Server (WSS) → ElevenLabs Conversational API
```

## Деплой на Render

1. Создай Git-репозиторий и запушь эти файлы
2. На render.com → New → Web Service → подключи репо
3. Render автоматически прочитает `render.yaml`
4. Добавь Environment Variables:
   - `ELEVENLABS_API_KEY` — ключ от ElevenLabs
   - `ELEVENLABS_AGENT_ID` — (опционально) ID агента в ElevenLabs
   - `TWILIO_TOKEN` — fd7c628bc9072b439fb9736669ba2b5e
5. Deploy

## Настройка Twilio

После деплоя, в Twilio Console:
1. Перейди в Phone Numbers → твой номер (+15855492907)
2. В "Voice & Fax" → "A Call Comes In" → Webhook
3. URL: `https://voice-server-XXXX.onrender.com/voice` (POST)

## Как позвонить

### Входящий звонок
Позвони на +15855492907 — Twilio перенаправит на сервер → ElevenLabs ответит голосом Гоши.

### Исходящий звонок
```bash
curl -X POST https://voice-server-XXXX.onrender.com/call
```
Сервер позвонит на +971507510161.

### Исходящий на другой номер
```bash
curl -X POST https://voice-server-XXXX.onrender.com/call \
  -H "Content-Type: application/json" \
  -d '{"to": "+1234567890"}'
```

## Endpoints

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/` | Health check |
| POST | `/voice` | Twilio webhook (TwiML) |
| POST | `/call` | Инициировать исходящий звонок |
| WSS | `/twilio-stream` | WebSocket для аудио-потока Twilio |

## Стоимость

~$6.50/час активного разговора:
- ElevenLabs: ~$0.10/мин
- Twilio: ~$0.0085/мин
