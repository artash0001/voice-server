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

// In-memory log buffer for /debug endpoint
const logBuffer = [];
const MAX_LOGS = 200;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "voice-server",
    env: {
      TWILIO_SID: TWILIO_SID ? "set" : "MISSING",
      TWILIO_TOKEN: TWILIO_TOKEN ? "set" : "MISSING",
      TWILIO_NUMBER: TWILIO_NUMBER || "MISSING",
      ELEVENLABS_API_KEY: ELEVENLABS_API_KEY ? "set" : "MISSING",
      ELEVENLABS_AGENT_ID: ELEVENLABS_AGENT_ID || "not set (using inline config)",
      CALL_TO,
    },
  });
});

// Debug logs
app.get("/debug", (_req, res) => {
  res.type("text/plain").send(logBuffer.join("\n") || "(no logs yet)");
});

// Twilio webhook — returns TwiML to connect call to WebSocket stream
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wsUrl = `wss://${host}/twilio-stream`;

  log(`[voice] incoming call, streaming to ${wsUrl}`);

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

  log(`[call] initiating call to ${to}, voiceUrl=${voiceUrl}`);

  try {
    const client = twilio(TWILIO_SID, TWILIO_TOKEN);
    const call = await client.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: voiceUrl,
    });
    log(`[call] created: ${call.sid}`);
    res.json({ ok: true, callSid: call.sid, to });
  } catch (err) {
    log(`[call] error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);

// WebSocket server for Twilio media streams
const wss = new WebSocketServer({ server, path: "/twilio-stream" });

wss.on("connection", (twilioWs, req) => {
  log("[ws] Twilio stream connected");

  let streamSid = null;
  let callSid = null;
  let elevenWs = null;
  let conversationId = null;

  function connectElevenLabs() {
    if (!ELEVENLABS_API_KEY) {
      log("[elevenlabs] ERROR: ELEVENLABS_API_KEY not set — cannot connect");
      return;
    }

    if (!ELEVENLABS_AGENT_ID) {
      log("[elevenlabs] ERROR: ELEVENLABS_AGENT_ID not set — required for Conversational API");
      return;
    }

    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}`;
    log(`[elevenlabs] connecting to ${wsUrl}`);

    elevenWs = new WebSocket(wsUrl, {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    });

    elevenWs.on("open", () => {
      log("[elevenlabs] WebSocket connected");

      // Send minimal initiation — agent config comes from ElevenLabs dashboard
      const initMsg = {
        type: "conversation_initiation_client_data",
      };
      elevenWs.send(JSON.stringify(initMsg));
      log("[elevenlabs] sent conversation_initiation_client_data");
    });

    elevenWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        log(`[elevenlabs] received: type=${msg.type}`);

        switch (msg.type) {
          case "conversation_initiation_metadata":
            conversationId = msg.conversation_id;
            log(`[elevenlabs] conversation started: ${conversationId}`);
            break;

          case "audio": {
            // ElevenLabs sends base64 mulaw audio — forward to Twilio
            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              const payload =
                msg.audio?.chunk ||
                msg.audio_event?.audio_base_64 ||
                msg.audio;
              if (typeof payload === "string" && payload.length > 0) {
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
            log(`[elevenlabs] agent says: ${msg.agent_response_event?.agent_response || JSON.stringify(msg)}`);
            break;

          case "user_transcript":
            log(`[elevenlabs] user said: ${msg.user_transcription_event?.user_transcript || JSON.stringify(msg)}`);
            break;

          case "interruption":
            log("[elevenlabs] user interrupted");
            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
            }
            break;

          case "ping": {
            const pong = { type: "pong" };
            if (msg.ping_event?.event_id) {
              pong.event_id = msg.ping_event.event_id;
            }
            elevenWs.send(JSON.stringify(pong));
            break;
          }

          case "error":
            log(`[elevenlabs] ERROR: ${JSON.stringify(msg)}`);
            break;

          default:
            log(`[elevenlabs] unhandled type=${msg.type}: ${JSON.stringify(msg).slice(0, 200)}`);
            break;
        }
      } catch (err) {
        log(`[elevenlabs] parse error: ${err.message}`);
      }
    });

    elevenWs.on("close", (code, reason) => {
      log(`[elevenlabs] closed: code=${code} reason=${reason}`);
      elevenWs = null;
    });

    elevenWs.on("error", (err) => {
      log(`[elevenlabs] ws error: ${err.message}`);
    });
  }

  twilioWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case "connected":
          log("[twilio] stream connected");
          break;

        case "start":
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          log(`[twilio] stream started: streamSid=${streamSid} callSid=${callSid}`);
          connectElevenLabs();
          break;

        case "media": {
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
          log("[twilio] stream stopped");
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            elevenWs.close();
          }
          break;
      }
    } catch (err) {
      log(`[twilio] parse error: ${err.message}`);
    }
  });

  twilioWs.on("close", () => {
    log("[ws] Twilio disconnected");
    if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    log(`[ws] Twilio error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  log(`[server] voice-server listening on port ${PORT}`);
  log(`[server] ELEVENLABS_API_KEY: ${ELEVENLABS_API_KEY ? "set" : "MISSING"}`);
  log(`[server] ELEVENLABS_AGENT_ID: ${ELEVENLABS_AGENT_ID || "MISSING"}`);
  log(`[server] TWILIO_SID: ${TWILIO_SID ? "set" : "MISSING"}`);
  log(`[server] endpoints: GET / | POST /voice | POST /call | GET /debug | WSS /twilio-stream`);
});
