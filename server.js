const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

const PORT = process.env.PORT || 10000;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const CALL_TO = process.env.CALL_TO || "+971507510161";
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || "+15855492907";

const SYSTEM_PROMPT = `Ты — Гоша, Growth Agent. Говоришь кратко, по-русски, прямым стилем.
Помогаешь с бизнесом, ростом и стратегией. Без воды, только суть.
Если не знаешь — честно скажи. Отвечаешь как партнёр, не как ассистент.`;

const FIRST_MESSAGE = "Привет, Арташес. Гоша на связи. Что будем растить сегодня?";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "voice-server" });
});

// Twilio webhook — returns TwiML to connect call to WebSocket stream
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const wsUrl = `wss://${host}/twilio-stream`;

  console.log(`[voice] incoming call, streaming to ${wsUrl}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Initiate outbound call
app.post("/call", async (req, res) => {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    return res.status(500).json({ error: "Twilio credentials not configured" });
  }

  const to = req.body?.to || CALL_TO;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const voiceUrl = `${proto}://${host}/voice`;

  console.log(`[call] initiating call to ${to}, voiceUrl=${voiceUrl}`);

  try {
    const client = twilio(TWILIO_SID, TWILIO_TOKEN);
    const call = await client.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: voiceUrl,
    });
    console.log(`[call] created: ${call.sid}`);
    res.json({ ok: true, callSid: call.sid, to });
  } catch (err) {
    console.error("[call] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);

// WebSocket server for Twilio media streams
const wss = new WebSocketServer({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWs, req) => {
  console.log("[ws] Twilio stream connected");

  let streamSid = null;
  let callSid = null;
  let elevenWs = null;
  let conversationId = null;

  function connectElevenLabs() {
    if (!ELEVENLABS_API_KEY) {
      console.error("[elevenlabs] ELEVENLABS_API_KEY not set");
      return;
    }

    // Use agent-based conversation endpoint if agent ID is set,
    // otherwise use direct conversation endpoint
    const wsUrl = ELEVENLABS_AGENT_ID
      ? `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`
      : "wss://api.elevenlabs.io/v1/convai/conversation";

    console.log(`[elevenlabs] connecting to ${wsUrl}`);

    elevenWs = new WebSocket(wsUrl, {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    });

    elevenWs.on("open", () => {
      console.log("[elevenlabs] connected");

      // If no agent ID, send initialization with inline config
      if (!ELEVENLABS_AGENT_ID) {
        const initMsg = {
          type: "conversation_initiation_client_data",
          conversation_config_override: {
            agent: {
              prompt: {
                prompt: SYSTEM_PROMPT,
              },
              first_message: FIRST_MESSAGE,
              language: "ru",
            },
            tts: {
              voice_id: "onwK4e9ZLuTAKqWW03F9", // Daniel — deep male voice
            },
          },
        };
        elevenWs.send(JSON.stringify(initMsg));
      }
    });

    elevenWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "conversation_initiation_metadata":
            conversationId = msg.conversation_id;
            console.log(`[elevenlabs] conversation started: ${conversationId}`);
            break;

          case "audio": {
            // ElevenLabs sends base64 audio chunks — forward to Twilio
            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              const payload = msg.audio?.chunk || msg.audio_event?.audio_base_64;
              if (payload) {
                twilioWs.send(
                  JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload },
                  })
                );
              }
            }
            break;
          }

          case "agent_response":
            console.log(`[elevenlabs] agent: ${msg.agent_response_event?.agent_response || ""}`);
            break;

          case "user_transcript":
            console.log(`[elevenlabs] user: ${msg.user_transcription_event?.user_transcript || ""}`);
            break;

          case "interruption":
            // Clear Twilio's audio buffer when user interrupts
            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
            }
            break;

          case "ping": {
            // Respond to keep-alive pings
            const pong = { type: "pong" };
            if (msg.ping_event?.event_id) {
              pong.event_id = msg.ping_event.event_id;
            }
            elevenWs.send(JSON.stringify(pong));
            break;
          }

          case "error":
            console.error("[elevenlabs] error:", JSON.stringify(msg));
            break;
        }
      } catch (err) {
        console.error("[elevenlabs] parse error:", err.message);
      }
    });

    elevenWs.on("close", (code, reason) => {
      console.log(`[elevenlabs] closed: code=${code} reason=${reason}`);
      elevenWs = null;
    });

    elevenWs.on("error", (err) => {
      console.error("[elevenlabs] ws error:", err.message);
    });
  }

  twilioWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          console.log("[twilio] stream connected");
          break;

        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          console.log(`[twilio] stream started: streamSid=${streamSid} callSid=${callSid}`);
          connectElevenLabs();
          break;

        case "media": {
          // Forward audio from Twilio to ElevenLabs
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            elevenWs.send(
              JSON.stringify({
                user_audio_chunk: msg.media.payload,
              })
            );
          }
          break;
        }

        case "stop":
          console.log("[twilio] stream stopped");
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            elevenWs.close();
          }
          break;
      }
    } catch (err) {
      console.error("[twilio] parse error:", err.message);
    }
  });

  twilioWs.on("close", () => {
    console.log("[ws] Twilio disconnected");
    if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("[ws] Twilio error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[server] voice-server listening on port ${PORT}`);
  console.log(`[server] endpoints:`);
  console.log(`  GET  /       — health check`);
  console.log(`  POST /voice  — Twilio webhook`);
  console.log(`  POST /call   — initiate outbound call`);
  console.log(`  WSS  /twilio-stream — Twilio media stream`);
});
