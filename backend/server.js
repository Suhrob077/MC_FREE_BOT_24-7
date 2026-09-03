/**
 * server.js
 * Minecraft AFK Bot — Backend (MULTI-USER VERSION, v2.1.0)
 * ---------------------------------------------------------
 * Express API that starts/stops mineflayer bots on demand.
 * Supports MULTIPLE concurrent bot sessions — each browser/user gets
 * their own isolated bot(s), tracked by a sessionId sent from the frontend.
 *
 * v2.1.0 — Aternos reliability fixes ported from Slobos-AFK-Aternos-Bot:
 *  - Much longer connect-phase timeout (Aternos can take 90-120s to
 *    finish spawning a player after the server wakes up)
 *  - Explicit mineflayer `checkTimeoutInterval` so mineflayer's own
 *    internal keep-alive watchdog doesn't kill a connection that's
 *    just being slow (this alone was the biggest cause of the
 *    endless "connect timeout... retrying" loop)
 *  - Aternos "Connection Throttled" kicks are now detected and get a
 *    long, deliberately slow backoff (60-120s) instead of being
 *    retried in 10s — retrying fast just makes Aternos throttle harder
 *  - A SINGLE reconnect trigger per bot ('end' only, never both
 *    'error' and 'end') — the old code could schedule two competing
 *    reconnect timers per drop, which is what caused the rapid
 *    reconnect spam visible in the logs
 *  - Real exponential backoff with jitter, capped, instead of two
 *    fixed delays
 *  - Process-level crash recovery: uncaughtException / unhandledRejection
 *    handlers so a raw socket write error (ECONNRESET/EPIPE/etc. thrown
 *    from inside mineflayer/node-minecraft-protocol internals, which
 *    bypasses our own try/catch blocks) can no longer take the whole
 *    backend down and kill every user's bot at once
 *  - Automatic fallback to version:false (protocol auto-detect) if the
 *    user-selected version repeatedly fails with a protocol/version
 *    error
 *  - Full input validation (host, port 1-65535, username 3-16 chars,
 *    version required)
 *  - Uzbek error code mapping (34 error codes) surfaced via publicState()
 *  - Anti-disconnect hardening: human-like periodic actions, connection
 *    watchdog (force-reconnect on a silent/frozen socket)
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

const WATCHDOG_CHECK_MS = 15 * 1000;        // how often we check for a frozen connection
const WATCHDOG_TIMEOUT_MS = 45 * 1000;      // no packets for this long => force reconnect

// Aternos servers frequently take 90-120s to finish authenticating/spawning
// a player once the underlying server has woken up. The old 20s timeout
// forced a retry before the server had any real chance to respond, which
// is the main reason the bot looked like it could never connect.
const CONNECT_TIMEOUT_MS = 150 * 1000;      // if we never reach spawn/error/end within this window

// mineflayer/node-minecraft-protocol has its OWN internal "did we hear
// anything from the server recently" watchdog (default ~30s), separate
// from CONNECT_TIMEOUT_MS above. On a slow-to-wake Aternos server this
// can fire and tear the socket down before our own logic even gets a
// chance to see what happened. Slobos-AFK works around this by setting
// it very high and relying on its own watchdog/timeouts instead — we do
// the same here.
const MINEFLAYER_CHECK_TIMEOUT_INTERVAL_MS = 600 * 1000;

// Reconnect backoff (exponential + jitter, single source of truth: only
// the 'end' event schedules a reconnect — never 'error' or 'kicked'
// directly, to avoid double-scheduling two competing timers).
const RECONNECT_BASE_MS = 5 * 1000;         // first retry after a normal drop
const RECONNECT_MAX_MS = 60 * 1000;         // cap for normal drops
const OFFLINE_BASE_MS = 20 * 1000;          // first retry when the server looks fully offline
const OFFLINE_MAX_MS = 5 * 60 * 1000;       // cap when the server looks fully offline

// Aternos actively throttles rapid reconnects ("Connection Throttled!
// Please wait before reconnecting."). Retrying fast just makes it worse,
// so a throttle kick always gets this much longer, semi-randomized delay.
const THROTTLE_MIN_DELAY_MS = 60 * 1000;
const THROTTLE_JITTER_MS = 60 * 1000;

const OFFLINE_ERROR_CODES = new Set([
  "connection_refused", "dns_error", "timeout", "firewall_blocked", "no_response",
]);

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
  too_many_requests: "Juda ko'p urinish (server ulanishni cheklamoqda, biroz kutilmoqda)",
  invalid_session: "Sessiyangiz yaroqsiz",
  protocol_error: "Protokol xatosi",
  compression_error: "Siqish xatosi",
  encryption_error: "Shifrlash xatosi",
  io_error: "Kirish/Chiqish xatosi",
  server_crashed: "Server quladi",
  no_response: "Server javob bermadi (server uyg'onayotgan bo'lishi mumkin, kutilmoqda)",
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
  if (msg.includes("throttl") || msg.includes("wait before reconnect") || msg.includes("too fast")) return "too_many_requests";

  return "unknown_error";
}

// Map a 'kicked' disconnect reason (string/object from the server) -> code.
function mapKickToCode(reason) {
  const text = (typeof reason === "string" ? reason : JSON.stringify(reason || "")).toLowerCase();
  if (text.includes("throttl") || text.includes("wait before reconnect") || text.includes("too fast")) return "too_many_requests";
  if (text.includes("whitelist")) return "not_whitelisted";
  if (text.includes("banned") || text.includes("ban")) return "banned";
  if (text.includes("full")) return "server_full";
  if (text.includes("outdated") && text.includes("server")) return "server_outdated";
  if (text.includes("outdated") && text.includes("client")) return "client_outdated";
  return "kicked";
}

function isThrottleText(reason) {
  const text = (typeof reason === "string" ? reason : JSON.stringify(reason || "")).toLowerCase();
  return text.includes("throttl") || text.includes("wait before reconnect") || text.includes("too fast");
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
    version: null,          // the version the user asked for (shown in UI)
    effectiveVersion: null, // the version actually passed to mineflayer (may fall back to false)
    startedAt: null,
    durationMinutes: null,
    stopTimer: null,
    msaLogin: null,
    lastError: null, // { code, message, raw } or null

    // internal bookkeeping (not exposed via publicState)
    humanActionInterval: null,
    watchdogInterval: null,
    reconnectTimer: null,
    connectTimeoutTimer: null,
    lastPacketAt: null,
    stopping: false,          // true once the user explicitly stops the bot
    reconnectScheduled: false, // guards against double-scheduling a reconnect
    reconnectAttempts: 0,      // resets to 0 on a successful spawn
    wasThrottled: false,       // set by a throttle kick, consumed by getReconnectDelay
    versionFailStreak: 0,      // consecutive protocol/version errors, triggers auto-fallback
  };
}

function clearAllTimers(state) {
  if (state.stopTimer) clearTimeout(state.stopTimer);
  if (state.humanActionInterval) clearInterval(state.humanActionInterval);
  if (state.watchdogInterval) clearInterval(state.watchdogInterval);
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.connectTimeoutTimer) clearTimeout(state.connectTimeoutTimer);
  state.stopTimer = null;
  state.humanActionInterval = null;
  state.watchdogInterval = null;
  state.reconnectTimer = null;
  state.connectTimeoutTimer = null;
}

function stopBot(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.state.stopping = true;
  clearAllTimers(session.state);
  if (session.bot) {
    try {
      session.bot.removeAllListeners();
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
    if (!cur || !cur.bot || cur.bot !== newBot) return;
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
    if (!cur || cur.bot !== newBot) return;
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

// Exponential backoff + jitter. Aternos throttle kicks always win with a
// long, semi-randomized delay — retrying fast after a throttle just makes
// Aternos throttle harder, which was the actual cause of the endless
// "no response from server, retrying" loop.
function getReconnectDelay(state) {
  if (state.wasThrottled) {
    state.wasThrottled = false;
    return THROTTLE_MIN_DELAY_MS + Math.floor(Math.random() * THROTTLE_JITTER_MS);
  }

  const looksOffline = state.lastError && OFFLINE_ERROR_CODES.has(state.lastError.code);
  const base = looksOffline ? OFFLINE_BASE_MS : RECONNECT_BASE_MS;
  const max = looksOffline ? OFFLINE_MAX_MS : RECONNECT_MAX_MS;
  const attempts = Math.min(state.reconnectAttempts || 0, 8); // cap the exponent
  const delay = Math.min(base * Math.pow(1.7, attempts), max);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

// Single source of truth for scheduling a reconnect. Only ever called from
// the 'end' event (or a hard createBot() throw). Never called from both
// 'error' and 'end' for the same drop — that double-scheduling is what
// used to fire two competing reconnect timers per disconnect.
function scheduleReconnect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || s.state.stopping) return;
  if (s.state.reconnectScheduled) return; // already have one queued
  if (s.state.reconnectTimer) clearTimeout(s.state.reconnectTimer);

  s.state.status = "reconnecting";
  s.state.reconnectScheduled = true;
  s.state.reconnectAttempts = (s.state.reconnectAttempts || 0) + 1;

  const delay = getReconnectDelay(s.state);
  console.log(`♻️  [${sessionId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${s.state.reconnectAttempts})`);

  s.state.reconnectTimer = setTimeout(() => {
    const cur = sessions.get(sessionId);
    if (!cur || cur.state.stopping) return;
    cur.state.reconnectScheduled = false;
    cur.state.reconnectTimer = null;
    cur.state.status = "connecting";
    cur.bot = spawnBot(
      {
        host: cur.state.host,
        port: cur.state.port,
        username: cur.state.username,
        authMode: cur.state.authMode,
        version: cur.state.version,
        effectiveVersion: cur.state.effectiveVersion,
      },
      sessionId
    );
  }, delay);
}

function spawnBot({ host, port, username, authMode, version, effectiveVersion }, sessionId) {
  // If the user's chosen version has repeatedly failed with a protocol/
  // version error, fall back to auto-detect (version: false) instead of
  // continuing to hammer a version mineflayer can't speak to this server.
  const versionToUse = effectiveVersion !== undefined ? effectiveVersion : version;

  const options = {
    host,
    port: port || 25565,
    username: username || "AFKBot",
    version: versionToUse, // string, or false for auto-detect after fallback
    auth: authMode === "premium" ? "microsoft" : "offline",
    hideErrors: false,
    // Prevents mineflayer's own internal "haven't heard from the server in
    // a while" watchdog from tearing the socket down while a slow-to-wake
    // Aternos server is still starting up / authenticating.
    checkTimeoutInterval: MINEFLAYER_CHECK_TIMEOUT_INTERVAL_MS,
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
      // No bot instance exists, so no 'end' event will ever fire for this
      // attempt — this is the one case where we schedule directly.
      if (!s.state.stopping) scheduleReconnect(sessionId);
    }
    return null;
  }

  // Connect-phase timeout: if we never reach 'spawn' (or an error/end that
  // already schedules a retry) within CONNECT_TIMEOUT_MS, the connection is
  // most likely still being negotiated by a slow-waking Aternos server, or
  // being silently dropped (no TCP RST, no protocol error) — e.g. by an
  // upstream proxy/firewall. Force it closed and retry instead of leaving
  // the UI stuck on "Ulanmoqda..." forever.
  {
    const s0 = sessions.get(sessionId);
    if (s0) {
      if (s0.state.connectTimeoutTimer) clearTimeout(s0.state.connectTimeoutTimer);
      s0.state.connectTimeoutTimer = setTimeout(() => {
        const cur = sessions.get(sessionId);
        if (!cur || cur.state.stopping || cur.bot !== newBot) return;
        if (cur.state.status === "connecting") {
          console.log(`⌛ [${sessionId}] Connect timeout after ${CONNECT_TIMEOUT_MS / 1000}s (no response from server), retrying`);
          cur.state.lastError = uzbekError("no_response");
          try {
            newBot.end("connect_timeout");
          } catch (e) {
            // end() itself may throw if the socket never opened; force retry directly
            scheduleReconnect(sessionId);
          }
        }
      }, CONNECT_TIMEOUT_MS);
    }
  }

  newBot.once("spawn", () => {
    const s = sessions.get(sessionId);
    if (!s || s.bot !== newBot) return;
    if (s.state.connectTimeoutTimer) {
      clearTimeout(s.state.connectTimeoutTimer);
      s.state.connectTimeoutTimer = null;
    }
    s.state.status = "online";
    s.state.msaLogin = null;
    s.state.lastError = null;
    s.state.reconnectAttempts = 0;   // successful spawn resets the backoff
    s.state.versionFailStreak = 0;
    console.log(`✅ [${sessionId}] Connected to ${host}:${port} as ${username} (v${newBot.version || versionToUse || "auto"})`);

    startHumanActions(newBot, sessionId);
    startWatchdog(newBot, sessionId);
  });

  // 'kicked' only records what happened and flags a throttle. It never
  // schedules a reconnect itself — 'end' always fires right after 'kicked'
  // and is the single place that does that.
  newBot.on("kicked", (reason) => {
    const s = sessions.get(sessionId);
    if (!s || s.bot !== newBot) return;
    const code = mapKickToCode(reason);
    s.state.lastError = uzbekError(code, typeof reason === "string" ? reason : JSON.stringify(reason));
    console.log(`👢 [${sessionId}] Kicked (${code}):`, reason);
    if (isThrottleText(reason)) {
      console.log(`🐢 [${sessionId}] Aternos throttle detected — next reconnect will use an extended delay`);
      s.state.wasThrottled = true;
    }
  });

  // 'error' only records what happened. It never schedules a reconnect
  // itself — 'end' fires right after and is the single reconnect trigger.
  // (Scheduling from both used to create two competing reconnect timers
  // per drop, which is what produced the rapid-fire retry loop.)
  newBot.on("error", (err) => {
    const s = sessions.get(sessionId);
    if (!s || s.bot !== newBot) return;
    const code = mapErrorToCode(err);
    s.state.lastError = uzbekError(code, err.message);
    console.log(`❌ [${sessionId}] Error (${code}):`, err.code || err.message);

    if (code === "unsupported_version" || code === "protocol_error") {
      s.state.versionFailStreak = (s.state.versionFailStreak || 0) + 1;
      if (s.state.versionFailStreak >= 2 && s.state.effectiveVersion !== false) {
        console.log(`🔄 [${sessionId}] Repeated version/protocol errors — falling back to auto-detect version`);
        s.state.effectiveVersion = false;
      }
    }

    if (!s.state.stopping) s.state.status = "error";
  });

  newBot.on("end", () => {
    const s = sessions.get(sessionId);
    if (!s || s.bot !== newBot) return;
    clearAllTimers(s.state);
    if (s.state.stopping) return;

    console.log(`🔌 [${sessionId}] Disconnected, scheduling reconnect...`);
    scheduleReconnect(sessionId);
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
    state.effectiveVersion = state.version;
    state.status = "connecting";
    state.startedAt = Date.now();
    state.durationMinutes = durationMinutes ? Number(durationMinutes) : null;

    sessions.set(sessionId, { bot: null, state });

    const bot = spawnBot(
      {
        host: state.host,
        port: state.port,
        username: state.username,
        authMode: state.authMode,
        version: state.version,
        effectiveVersion: state.effectiveVersion,
      },
      sessionId
    );

    const session = sessions.get(sessionId);
    if (session) session.bot = bot;

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

// ---- Health check (useful for uptime monitors / free-tier host pings) ----
app.get("/", (req, res) => {
  res.json({ status: "ok", activeSessions: sessions.size, maxSessions: MAX_CONCURRENT_BOTS });
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

// ---------------------------------------------------------------------
// CRASH RECOVERY — this is the single most important fix ported over.
// mineflayer / node-minecraft-protocol can throw a raw socket write error
// (ECONNRESET, EPIPE, "write after end", "This socket has been ended",
// PartialReadError) from deep inside its own internals — completely
// outside any of our try/catch blocks. Without a process-level handler,
// that one exception kills the entire Node process and takes down every
// user's bot at once, which is exactly the pattern visible in the logs
// (a clean disconnect, immediately followed by an uncaught ECONNRESET
// write error with no further log lines after it — the process died).
// ---------------------------------------------------------------------
function isRecoverableNetworkError(msg) {
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("PartialReadError") ||
    msg.includes("write after end") ||
    msg.includes("This socket has been ended") ||
    msg.includes("timed out")
  );
}

process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error("💥 [FATAL] Uncaught exception:", msg);

  if (isRecoverableNetworkError(msg)) {
    console.error("🩹 Known network/protocol error — backend stays alive, affected session(s) will auto-reconnect.");
  } else {
    console.error("🩹 Unknown error type — backend stays alive rather than crashing all sessions. Consider reporting this.");
  }
  // Deliberately NOT rethrowing / exiting: crashing here would kill every
  // other user's bot along with the one that hit the error. Any session
  // whose bot actually died will already have its own 'end'/'error'
  // handlers scheduling a reconnect; there is nothing else to do here.
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason && reason.message ? reason.message : reason);
  console.error("💥 [FATAL] Unhandled rejection:", msg);
  if (isRecoverableNetworkError(msg)) {
    console.error("🩹 Known network/protocol error — backend stays alive, affected session(s) will auto-reconnect.");
  } else {
    console.error("🩹 Unknown error type — backend stays alive rather than crashing all sessions. Consider reporting this.");
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Minecraft bot backend running on port ${PORT}`);
});

// ---------------------------------------------------------------------
// Optional self-ping keep-alive for free-tier hosts (Render, etc.) that
// spin the service down after a period of inactivity. Set SELF_URL to
// this service's own public URL to enable it; harmless if left unset.
// ---------------------------------------------------------------------
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const https = require("https");
  const http = require("http");
  const SELF_PING_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    try {
      const protocol = SELF_URL.startsWith("https") ? https : http;
      protocol.get(SELF_URL, (res) => { res.resume(); }).on("error", (e) => {
        console.log("⚠️  Self-ping failed:", e.message);
      });
    } catch (e) {
      /* ignore */
    }
  }, SELF_PING_INTERVAL_MS);
  console.log(`💓 Self-ping keep-alive enabled -> ${SELF_URL} every ${SELF_PING_INTERVAL_MS / 60000}min`);
}
