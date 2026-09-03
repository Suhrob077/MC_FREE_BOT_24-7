/**
 * server.js
 * Minecraft AFK Bot — Backend (MULTI-USER VERSION, v2.0.0)
 * ---------------------------------------------------------
 * Express API that starts/stops mineflayer bots on demand.
 * Supports MULTIPLE concurrent bot sessions — each browser/user gets
 * their own isolated bot(s), tracked by a sessionId sent from the frontend.
 *
 * v2.0.0 feature set:
 *  - Full input validation (host, port 1-65535, username 3-16 chars,
 *    version required)
 *  - Uzbek error code mapping (34 error codes) surfaced via publicState()
 *  - Anti-disconnect hardening:
 *      - human-like periodic actions (look / jump / sneak / short walk)
 *      - connection watchdog (force-reconnect on a silent/frozen socket)
 *      - smart reconnect backoff (fast retry on normal drop, slow retry
 *        when the server looks fully offline, so we don't hammer it)
 *  - Detailed emoji logging
 */

const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_BOTS = 20; // simple safety cap, raise/lower as needed

const WATCHDOG_CHECK_MS = 15 * 1000;      // how often we check for a frozen connection
const WATCHDOG_TIMEOUT_MS = 45 * 1000;    // no packets for this long => force reconnect
const FAST_RETRY_MS = 10 * 1000;          // normal disconnect / kick
const SLOW_RETRY_MS = 5 * 60 * 1000;      // looks like server is offline

// Every real Minecraft Java Edition release from 1.12.2 to the current
// latest (26.2), in chronological order. Mojang switched from 1.x numbering
// to calendar versioning (YY.drop.patch) after 1.21.11 — there is no
// 1.22/1.23/etc, the next release after 1.21.11 was 26.1.
//
// NOTE: mineflayer's actual protocol support for the newest calendar
// versions (26.1, 26.2) depends entirely on which mineflayer/minecraft-data
// release you have installed — these are very new and may not be supported
// yet. Always test against your real server; if a version fails, try ""
// (auto-detect) instead.
const SUPPORTED_VERSIONS = [
  "1.12.2", "1.13", "1.13.1", "1.13.2",
  "1.14", "1.14.1", "1.14.2", "1.14.3", "1.14.4",
  "1.15", "1.15.1", "1.15.2",
  "1.16", "1.16.1", "1.16.2", "1.16.3", "1.16.4", "1.16.5",
  "1.17", "1.17.1",
  "1.18", "1.18.1", "1.18.2",
  "1.19", "1.19.1", "1.19.2", "1.19.3", "1.19.4",
  "1.20", "1.20.1", "1.20.2", "1.20.3", "1.20.4", "1.20.5", "1.20.6",
  "1.21", "1.21.1", "1.21.2", "1.21.3", "1.21.4", "1.21.5", "1.21.6", "1.21.7", "1.21.8", "1.21.9", "1.21.10", "1.21.11",
  "26.1", "26.1.1", "26.1.2", "26.2",
];

// ---------------------------------------------------------------------
// Uzbek error dictionary (34 codes) — every code below is user-facing.
// ---------------------------------------------------------------------
const UZBEK_ERRORS = {
  host_required: "Server IP/manzili noto'g'ri yoki bo'sh!",
  invalid_port: "Port raqami noto'g'ri (1-65535 oralig'ida bo'lishi kerak)",
  invalid_username: "Foydalanuvchi nomi 3-16 belgidan iborat bo'lishi kerak",
  version_required: "Minecraft versiyasini tanlab olish majburiy!",
  unsupported_version: "Bu versiya taqdim qilinmagan yoki qo'llanmaydi",
  connection_refused: "Server ulanishni rad etdi",
  timeout: "Ulanish vaqti tugadi",
  network_error: "Tarmoq xatosi",
  auth_failed: "Foydalanuvchi nomi yoki parol noto'g'ri (Premium)",
  server_full: "Server to'lgan",
  kicked: "Server sizni chiqarib tashladi",
  client_outdated: "Client versiyasi eski",
  server_outdated: "Server eski versiyasida",
  authentication_failed: "Autentifikatsiya muvaffaqiyatsiz",
  msa_required: "Microsoft hisob tasdiqlanishi kerak",
  access_denied: "Kirish ruxsati berilmagan",
  not_whitelisted: "Siz server whitelist'ida emassiz",
  banned: "Siz bu serverdan bloklangansiz",
  too_many_requests: "Juda ko'p urinish",
  invalid_session: "Sessiyangiz yaroqsiz",
  protocol_error: "Protokol xatosi",
  compression_error: "Siqish xatosi",
  encryption_error: "Shifrlash xatosi",
  io_error: "Kirish/Chiqish xatosi",
  server_crashed: "Server quladi",
  no_response: "Server javob bermadi",
  dns_error: "Server manzilini topib bo'lmadi",
  firewall_blocked: "Fayervol tomonidan bloklandi",
  malformed_data: "Server noto'g'ri ma'lumot yubordi",
  server_not_exist: "Server mavjud emas",
  connection_lost: "Ulanish yo'qoldi",
  backend_error: "Backend xatosi",
  capacity_exceeded: "Server sig'imi oshib ketdi",
  unknown_error: "Noma'lum xatolik yuz berdi",
};

function uzbekError(code, fallbackRaw) {
  return {
    code,
    message: UZBEK_ERRORS[code] || UZBEK_ERRORS.unknown_error,
    raw: fallbackRaw || null,
  };
}

// Map a raw mineflayer/node error object -> one of our Uzbek error codes.
function mapErrorToCode(err) {
  const msg = (err && err.message ? err.message : String(err || "")).toLowerCase();
  const code = err && err.code;

  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "ECONNRESET") return "connection_lost";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "firewall_blocked";
  if (code === "EPIPE") return "io_error";

  if (msg.includes("invalid credentials") || msg.includes("invalid session")) return "invalid_session";
  if (msg.includes("premium") || msg.includes("password")) return "auth_failed";
  if (msg.includes("outdated server") || msg.includes("server is on an older version")) return "server_outdated";
  if (msg.includes("outdated client") || msg.includes("please use") && msg.includes("newer")) return "client_outdated";
  if (msg.includes("unsupported protocol") || msg.includes("not supported")) return "unsupported_version";
  if (msg.includes("compress")) return "compression_error";
  if (msg.includes("encrypt")) return "encryption_error";
  if (msg.includes("partialreaderror") || msg.includes("protocol")) return "protocol_error";
  if (msg.includes("whitelist")) return "not_whitelisted";
  if (msg.includes("banned")) return "banned";
  if (msg.includes("full")) return "server_full";
  if (msg.includes("timed out") || msg.includes("timeout")) return "timeout";

  return "unknown_error";
}

// Map a 'kicked' disconnect reason (string/object from the server) -> code.
function mapKickToCode(reason) {
  const text = (typeof reason === "string" ? reason : JSON.stringify(reason || "")).toLowerCase();
  if (text.includes("whitelist")) return "not_whitelisted";
  if (text.includes("banned") || text.includes("ban")) return "banned";
  if (text.includes("full")) return "server_full";
  if (text.includes("outdated") && text.includes("server")) return "server_outdated";
  if (text.includes("outdated") && text.includes("client")) return "client_outdated";
  return "kicked";
}

// ---- Multiple sessions: sessionId -> { bot, state } ----
const sessions = new Map();

function freshState() {
  return {
    status: "offline", // offline | connecting | online | reconnecting | error
    host: null,
    port: null,
    username: null,
    authMode: null,
    version: null,
    startedAt: null,
    durationMinutes: null,
    stopTimer: null,
    msaLogin: null,
    lastError: null, // { code, message, raw }

    // internal bookkeeping (not exposed via publicState)
    humanActionInterval: null,
    watchdogInterval: null,
    reconnectTimer: null,
    lastPacketAt: null,
    stopping: false, // true once the user explicitly stops the bot
  };
}

function clearAllTimers(state) {
  if (state.stopTimer) clearTimeout(state.stopTimer);
  if (state.humanActionInterval) clearInterval(state.humanActionInterval);
  if (state.watchdogInterval) clearInterval(state.watchdogInterval);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.stopTimer = null;
  state.humanActionInterval = null;
  state.watchdogInterval = null;
  state.reconnectTimer = null;
}

function stopBot(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.state.stopping = true;
  clearAllTimers(session.state);
  if (session.bot) {
    try {
      session.bot.quit();
    } catch (e) {
      /* ignore */
    }
  }
  sessions.delete(sessionId);
  console.log(`🛑 [${sessionId}] Bot stopped by user`);
}

// ---- Human-like idle behaviour: less robotic than a fixed look() tick ----
function startHumanActions(newBot, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.state.humanActionInterval) clearInterval(s.state.humanActionInterval);

  s.state.humanActionInterval = setInterval(() => {
    const cur = sessions.get(sessionId);
    if (!cur || !cur.bot) return;
    try {
      const action = Math.random();
      if (action < 0.4) {
        newBot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.5, true);
      } else if (action < 0.55) {
        newBot.setControlState("jump", true);
        setTimeout(() => { try { newBot.setControlState("jump", false); } catch (e) {} }, 250);
      } else if (action < 0.7) {
        newBot.setControlState("sneak", true);
        setTimeout(() => { try { newBot.setControlState("sneak", false); } catch (e) {} }, 600);
      } else if (action < 0.9) {
        newBot.look(Math.random() * Math.PI * 2, 0, true);
        newBot.setControlState("forward", true);
        setTimeout(() => { try { newBot.setControlState("forward", false); } catch (e) {} }, 400 + Math.random() * 600);
      } else {
        newBot.swingArm();
      }
    } catch (e) {
      /* ignore transient errors from actions racing a disconnect */
    }
  }, 15000 + Math.random() * 15000); // every 15-30s, randomized
}

// ---- Watchdog: force-reconnect if the socket goes silent without erroring ----
function startWatchdog(newBot, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.state.watchdogInterval) clearInterval(s.state.watchdogInterval);

  s.state.lastPacketAt = Date.now();
  try {
    newBot._client.on("packet", () => {
      const cur = sessions.get(sessionId);
      if (cur) cur.state.lastPacketAt = Date.now();
    });
  } catch (e) {
    /* ignore */
  }

  s.state.watchdogInterval = setInterval(() => {
    const cur = sessions.get(sessionId);
    if (!cur) return;
    const silentFor = Date.now() - (cur.state.lastPacketAt || Date.now());
    if (silentFor > WATCHDOG_TIMEOUT_MS) {
      console.log(`🧊 [${sessionId}] Watchdog: no packets for ${Math.round(silentFor / 1000)}s, forcing reconnect`);
      try {
        newBot.end("watchdog_timeout");
      } catch (e) {
        /* ignore, the 'end' handler still schedules a reconnect */
      }
    }
  }, WATCHDOG_CHECK_MS);
}

function scheduleReconnect(sessionId, delayMs) {
  const s = sessions.get(sessionId);
  if (!s || s.state.stopping) return;
  if (s.state.reconnectTimer) clearTimeout(s.state.reconnectTimer);

  s.state.status = "reconnecting";
  s.state.reconnectTimer = setTimeout(() => {
    const cur = sessions.get(sessionId);
    if (!cur || cur.state.stopping) return;
    console.log(`♻️  [${sessionId}] Reconnecting...`);
    cur.state.status = "connecting";
    cur.bot = spawnBot(
      {
        host: cur.state.host,
        port: cur.state.port,
        username: cur.state.username,
        authMode: cur.state.authMode,
        version: cur.state.version,
      },
      sessionId
    );
  }, delayMs);
}

function spawnBot({ host, port, username, authMode, version }, sessionId) {
  const options = {
    host,
    port: port || 25565,
    username: username || "AFKBot",
    version: version, // required by validation, always a real string here
    auth: authMode === "premium" ? "microsoft" : "offline",
  };

  if (authMode === "premium") {
    options.onMsaCode = (data) => {
      const s = sessions.get(sessionId);
      if (s) s.state.msaLogin = { url: data.verification_uri, code: data.user_code };
    };
  }

  let newBot;
  try {
    newBot = mineflayer.createBot(options);
  } catch (err) {
    const s = sessions.get(sessionId);
    if (s) {
      const code = mapErrorToCode(err);
      s.state.status = "error";
      s.state.lastError = uzbekError(code, err.message);
      console.log(`❌ [${sessionId}] createBot threw:`, err.message);
      if (!s.state.stopping) scheduleReconnect(sessionId, FAST_RETRY_MS);
    }
    return null;
  }

  newBot.once("spawn", () => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.state.status = "online";
    s.state.msaLogin = null;
    s.state.lastError = null;
    console.log(`✅ [${sessionId}] Connected to ${host}:${port} as ${username} (v${version})`);

    startHumanActions(newBot, sessionId);
    startWatchdog(newBot, sessionId);
  });

  newBot.on("kicked", (reason) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    const code = mapKickToCode(reason);
    s.state.lastError = uzbekError(code, typeof reason === "string" ? reason : JSON.stringify(reason));
    console.log(`👢 [${sessionId}] Kicked (${code}):`, reason);
  });

  newBot.on("error", (err) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    const code = mapErrorToCode(err);
    s.state.lastError = uzbekError(code, err.message);
    console.log(`❌ [${sessionId}] Error (${code}):`, err.code || err.message);

    if (!s.state.stopping) {
      const looksOffline = code === "connection_refused" || code === "dns_error" || code === "timeout" || code === "firewall_blocked";
      s.state.status = "error";
      scheduleReconnect(sessionId, looksOffline ? SLOW_RETRY_MS : FAST_RETRY_MS);
    }
  });

  newBot.on("end", () => {
    const s = sessions.get(sessionId);
    if (!s) return;
    clearAllTimers(s.state);
    if (s.state.stopping) return;

    console.log(`🔌 [${sessionId}] Disconnected, scheduling reconnect...`);
    scheduleReconnect(sessionId, FAST_RETRY_MS);
  });

  return newBot;
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------
function validateStartInput(body) {
  const { sessionId, host, port, username, version } = body;

  if (!sessionId) return uzbekError("invalid_session");
  if (!host || typeof host !== "string" || !host.trim()) return uzbekError("host_required");

  if (port !== undefined && port !== null && port !== "") {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return uzbekError("invalid_port");
  }

  if (!username || typeof username !== "string" || username.trim().length < 3 || username.trim().length > 16) {
    return uzbekError("invalid_username");
  }

  if (!version || typeof version !== "string" || !version.trim()) {
    return uzbekError("version_required");
  }
  if (!SUPPORTED_VERSIONS.includes(version.trim())) {
    return uzbekError("unsupported_version", version);
  }

  return null; // no error
}

// ---- API: start a bot (one per sessionId) ----
app.post("/api/bot/start", (req, res) => {
  try {
    const validationError = validateStartInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { sessionId, host, port, username, authMode, durationMinutes, version } = req.body;

    if (sessions.size >= MAX_CONCURRENT_BOTS && !sessions.has(sessionId)) {
      return res.status(429).json({ error: uzbekError("capacity_exceeded") });
    }

    if (sessions.has(sessionId)) stopBot(sessionId);

    const state = freshState();
    state.host = host.trim();
    state.port = port ? Number(port) : 25565;
    state.username = username.trim();
    state.authMode = authMode === "premium" ? "premium" : "cracked";
    state.version = version.trim();
    state.status = "connecting";
    state.startedAt = Date.now();
    state.durationMinutes = durationMinutes ? Number(durationMinutes) : null;

    const bot = spawnBot(
      { host: state.host, port: state.port, username: state.username, authMode: state.authMode, version: state.version },
      sessionId
    );

    sessions.set(sessionId, { bot, state });

    if (state.durationMinutes) {
      state.stopTimer = setTimeout(() => {
        console.log(`⏱️  [${sessionId}] Duration reached, stopping.`);
        stopBot(sessionId);
      }, state.durationMinutes * 60 * 1000);
    }

    console.log(`🚀 [${sessionId}] Starting bot -> ${state.host}:${state.port} as ${state.username} (v${state.version}, ${state.authMode})`);
    res.json({ message: "Bot starting", state: publicState(sessionId) });
  } catch (err) {
    console.error("💥 /api/bot/start crashed:", err);
    res.status(500).json({ error: uzbekError("backend_error", err.message) });
  }
});

// ---- API: stop a specific user's bot ----
app.post("/api/bot/stop", (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: uzbekError("invalid_session") });
    stopBot(sessionId);
    res.json({ message: "Bot stopped", state: publicState(sessionId) });
  } catch (err) {
    console.error("💥 /api/bot/stop crashed:", err);
    res.status(500).json({ error: uzbekError("backend_error", err.message) });
  }
});

// ---- API: status for a specific session ----
app.get("/api/bot/status", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: uzbekError("invalid_session") });
  res.json(publicState(sessionId));
});

// ---- API: how many bots are currently running (global, for capacity display) ----
app.get("/api/bot/count", (req, res) => {
  res.json({ active: sessions.size, max: MAX_CONCURRENT_BOTS });
});

// ---- API: list of Minecraft versions the frontend dropdown should offer ----
app.get("/api/versions", (req, res) => {
  res.json({ versions: SUPPORTED_VERSIONS });
});

function publicState(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { status: "offline" };
  return {
    status: s.state.status,
    host: s.state.host,
    port: s.state.port,
    username: s.state.username,
    authMode: s.state.authMode,
    version: s.state.version,
    startedAt: s.state.startedAt,
    durationMinutes: s.state.durationMinutes,
    msaLogin: s.state.msaLogin,
    lastError: s.state.lastError, // { code, message, raw } or null
  };
}

app.listen(PORT, () => {
  console.log(`🟢 Minecraft bot backend running on port ${PORT}`);
});
