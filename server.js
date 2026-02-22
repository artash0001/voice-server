const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const CALL_TO = process.env.CALL_TO;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const VOICE_API_KEY = process.env.VOICE_API_KEY;
const ALLOWED_HOST = process.env.ALLOWED_HOST; // e.g. "voice.example.com"

// In-memory log buffer for /debug endpoint
const logBuffer = [];
const MAX_LOGS = 200;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  // Twilio webhook requests are validated separately
  if (req.path === "/voice") return next();

  if (!VOICE_API_KEY) {
    log("[auth] WARNING: VOICE_API_KEY not set, all requests rejected");
    return res.status(503).json({ error: "Server not configured" });
  }

  const provided =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

  if (!provided || !safeEqual(provided, VOICE_API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- Twilio request validation middleware ---
function validateTwilioRequest(req, res, next) {
  if (!TWILIO_TOKEN) return next(); // skip if not configured
  const twilioSignature = req.headers["x-twilio-signature"];
  if (!twilioSignature) {
    log("[auth] missing Twilio signature on /voice");
    return res.status(403).send("Forbidden");
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = ALLOWED_HOST || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;
  const valid = twilio.validateRequest(TWILIO_TOKEN, twilioSignature, url, req.body || {});
  if (!valid) {
    log("[auth] invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }
  next();
}

// --- Host validation ---
function getValidatedHost(req) {
  if (ALLOWED_HOST) return ALLOWED_HOST;
  // Only trust host header, never x-forwarded-host from untrusted sources
  const host = req.headers.host || "";
  // Strip port, validate no special chars that could break TwiML/URLs
  if (!/^[a-zA-Z0-9._:-]+$/.test(host)) {
    log(`[security] rejected invalid host header: ${host.slice(0, 100)}`);
    return null;
  }
  return host;
}

// Get signed URL for ElevenLabs conversation
async function getSignedUrl() {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(ELEVENLABS_AGENT_ID)}`,
    {
      method: "GET",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
    }
  );
  if (!response.ok) {
    throw new Error(`Failed to get signed URL: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.signed_url;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check (auth required — no env details exposed)
app.get("/", requireAuth, (_req, res) => {
  res.json({
    status: "ok",
    service: "voice-server",
    env: {
      TWILIO_SID: TWILIO_SID ? "set" : "MISSING",
      TWILIO_TOKEN: TWILIO_TOKEN ? "set" : "MISSING",
      TWILIO_NUMBER: TWILIO_NUMBER ? "set" : "MISSING",
      ELEVENLABS_API_KEY: ELEVENLABS_API_KEY ? "set" : "MISSING",
      ELEVENLABS_AGENT_ID: ELEVENLABS_AGENT_ID ? "set" : "MISSING",
      CALL_TO: CALL_TO ? "set" : "MISSING",
    },
  });
});

// Debug logs (auth required)
app.get("/debug", requireAuth, (_req, res) => {
  res.type("text/plain").send(logBuffer.join("\n") || "(no logs yet)");
});

// Twilio webhook — returns TwiML to connect call to WebSocket stream
// Validated via Twilio request signature instead of API key
app.post("/voice", validateTwilioRequest, (req, res) => {
  const host = getValidatedHost(req);
  if (!host) {
    return res.status(400).send("Bad Request");
  }
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

// Initiate outbound call (auth required)
app.post("/call", requireAuth, async (req, res) => {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    return res.status(500).json({ error: "Twilio credentials not configured" });
  }
  if (!TWILIO_NUMBER) {
    return res.status(500).json({ error: "TWILIO_NUMBER not configured" });
  }

  const to = req.body?.to || CALL_TO;
  if (!to || !/^\+[1-9]\d{6,14}$/.test(to)) {
    return res.status(400).json({ error: "Invalid phone number. Must be E.164 format (e.g. +14155551234)" });
  }

  const host = getValidatedHost(req);
  if (!host) {
    return res.status(400).json({ error: "Invalid host" });
  }
  const voiceUrl = `https://${host}/voice`;

  log(`[call] initiating call to ${to}, voiceUrl=${voiceUrl}`);

  try {
    const client = twilio(TWILIO_SID, TWILIO_TOKEN);
    const call = await client.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: voiceUrl,
    });
    log(`[call] created: ${call.sid}`);
    res.json({ ok: true, callSid: call.sid });
  } catch (err) {
    log(`[call] error: ${err.message}`);
    res.status(500).json({ error: "Failed to create call" });
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

  async function setupElevenLabs() {
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
      log("[elevenlabs] ERROR: ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID missing");
      return;
    }

    try {
      const signedUrl = await getSignedUrl();
      log(`[elevenlabs] got signed URL, connecting...`);

      elevenWs = new WebSocket(signedUrl);

      elevenWs.on("open", () => {
        log("[elevenlabs] WebSocket connected");

        // Send conversation initiation
        const initMsg = {
          type: "conversation_initiation_client_data",
          conversation_config_override: {
            agent: {
              prompt: {
                prompt: "Ты — Гоша, Growth Agent. Говоришь кратко, по-русски, прямым стилем. Помогаешь с бизнесом, ростом и стратегией.",
              },
              first_message: "Привет, Арташес. Гоша на связи. Что будем растить сегодня?",
            },
          },
        };
        elevenWs.send(JSON.stringify(initMsg));
        log("[elevenlabs] sent conversation_initiation_client_data");
      });

      elevenWs.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          switch (msg.type) {
            case "conversation_initiation_metadata":
              log(`[elevenlabs] conversation started: ${msg.conversation_id || "ok"}`);
              break;

            case "audio": {
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
              } else {
                log("[elevenlabs] got audio but no streamSid yet");
              }
              break;
            }

            case "agent_response":
              log(`[elevenlabs] agent: ${msg.agent_response_event?.agent_response || ""}`);
              break;

            case "user_transcript":
              log(`[elevenlabs] user: ${msg.user_transcription_event?.user_transcript || ""}`);
              break;

            case "interruption":
              log("[elevenlabs] interruption");
              if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
              }
              break;

            case "ping":
              if (msg.ping_event?.event_id) {
                elevenWs.send(
                  JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id })
                );
              }
              break;

            case "error":
              log(`[elevenlabs] ERROR: ${JSON.stringify(msg)}`);
              break;

            default:
              log(`[elevenlabs] ${msg.type}: ${JSON.stringify(msg).slice(0, 300)}`);
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
    } catch (err) {
      log(`[elevenlabs] setup error: ${err.message}`);
    }
  }

  // Start ElevenLabs connection immediately
  setupElevenLabs();

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
          break;

        case "media": {
          // Forward Twilio audio to ElevenLabs
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            const audioMessage = {
              user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64"),
            };
            elevenWs.send(JSON.stringify(audioMessage));
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
  log(`[server] VOICE_API_KEY: ${VOICE_API_KEY ? "set" : "MISSING — all requests will be rejected"}`);
  log(`[server] ELEVENLABS_API_KEY: ${ELEVENLABS_API_KEY ? "set" : "MISSING"}`);
  log(`[server] ELEVENLABS_AGENT_ID: ${ELEVENLABS_AGENT_ID ? "set" : "MISSING"}`);
  log(`[server] TWILIO_SID: ${TWILIO_SID ? "set" : "MISSING"}`);
  log(`[server] ALLOWED_HOST: ${ALLOWED_HOST || "(not set — using Host header)"}`);
  log(`[server] endpoints: GET / | POST /voice | POST /call | GET /debug | WSS /twilio-stream`);
});
