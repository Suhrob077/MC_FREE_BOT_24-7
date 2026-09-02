/**
server.js
 * Minecraft AFK Bot — Backend (MULTI-USER VERSION, v2)
 * -------------------------------------------------
 * Express API that starts/stops mineflayer bots on demand.
 * Supports MULTIPLE concurrent bot sessions — each browser/user gets
 * their own isolated bot(s), tracked by a sessionId sent from the frontend.
 *
 * NEW in v2:
 *  - Optional Minecraft version selection (falls back to auto-detect)
 *  - /api/bot/list endpoint (not used for cross-user listing, only kept
 *    for potential admin/debug use — the frontend tracks its own
 *    sessionIds in localStorage and polls /api/bot/status per session)
 */
 
const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");
 
const app = express();
app.use(cors());
app.use(express.json());
 
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_BOTS = 20;

// 🇺🇿 UZBEK ERROR MESSAGES MAPPING
const uzbekErrorMap = {
  "ECONNREFUSED": "connection_refused",
  "ENOTFOUND": "dns_error",
  "ETIMEDOUT": "timeout",
  "EHOSTUNREACH": "server_unreachable",
  "ENETUNREACH": "network_error",
  "getaddrinfo": "dns_error",
  "ECONNRESET": "connection_lost",
};

function mapErrorToCode(err) {
  const errStr = err.message || err.code || "";
  for (const [key, code] of Object.entries(uzbekErrorMap)) {
    if (errStr.includes(key)) return code;
  }
  if (errStr.includes("kicked")) return "kicked_by_server";
  if (errStr.includes("timeout")) return "timeout";
  if (errStr.includes("auth")) return "authentication_failed";
  if (errStr.includes("outdated")) return "kicked_outdated_client";
  return "server_error";
}
 
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
    reconnectInterval: null,
    msaLogin: null,
    lastError: null,
  };
}
 
function stopBot(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.state.stopTimer) clearTimeout(session.state.stopTimer);
  if (session.state.reconnectInterval) clearInterval(session.state.reconnectInterval);
  if (session.bot) {
    try {
      session.bot.quit();
    } catch (e) {
      /* ignore */
    }
  }
  sessions.delete(sessionId);
}
 
function spawnBot({ host, port, username, authMode, version }, sessionId) {
  const options = {
    host,
    port: port || 25565,
    username: username || "AFKBot",
    version: version || false, // false = auto-detect
    auth: authMode === "premium" ? "microsoft" : "offline",
  };
 
  if (authMode === "premium") {
    options.onMsaCode = (data) => {
      const s = sessions.get(sessionId);
      if (s) s.state.msaLogin = { url: data.verification_uri, code: data.user_code };
    };
  }
 
  const newBot = mineflayer.createBot(options);
 
  newBot.once("spawn", () => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.state.status = "online";
    s.state.msaLogin = null;
    s.state.lastError = null;
    console.log(`[${sessionId}] ✅ Online: ${host}:${port} as ${username}`);
  });
 
  newBot.on("kicked", (reason) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.state.status = "offline";
    let errorCode = "kicked_by_server";
    const reasonStr = reason.toString().toLowerCase();
    if (reasonStr.includes("whitelist")) errorCode = "whitelist_denied";
    else if (reasonStr.includes("ban")) errorCode = "banned";
    else if (reasonStr.includes("outdated")) errorCode = "kicked_outdated_client";
    s.state.lastError = errorCode;
    console.log(`[${sessionId}] ⛔ Kicked:`, reason);
  });
 
  newBot.on("error", (err) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.state.status = "error";
    const errorCode = mapErrorToCode(err);
    s.state.lastError = errorCode;
    console.log(`[${sessionId}] ❌ Error (${errorCode}):`, err.message);
  });
 
  newBot.on("end", () => {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (s.state.status !== "offline") {
      s.state.status = "reconnecting";
      console.log(`[${sessionId}] 🔄 Disconnected, retrying...`);
    }
  });
 
  return newBot;
}
 
// ---- API: start a bot (one per sessionId) ----
app.post("/api/bot/start", (req, res) => {
  const { sessionId, host, port, username, authMode, durationMinutes, version } = req.body;

  // 🔍 VALIDATION
  if (!sessionId || !host || !username) {
    return res.status(400).json({ error: "invalid_host" });
  }

  if (!version || version.trim() === "") {
    return res.status(400).json({ error: "version_required" });
  }

  // Validate username length
  if (username.length < 3 || username.length > 16) {
    return res.status(400).json({ error: "invalid_username" });
  }

  // Validate port
  const portNum = port ? Number(port) : 25565;
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: "invalid_port" });
  }

  // Check capacity
  if (sessions.size >= MAX_CONCURRENT_BOTS && !sessions.has(sessionId)) {
    return res.status(429).json({ error: "capacity_exceeded" });
  }

  if (sessions.has(sessionId)) stopBot(sessionId);

  const state = freshState();
  state.host = host;
  state.port = portNum;
  state.username = username;
  state.authMode = authMode === "premium" ? "premium" : "cracked";
  state.version = version || null;
  state.status = "connecting";
  state.startedAt = Date.now();
  state.durationMinutes = durationMinutes ? Number(durationMinutes) : null;

  try {
    const bot = spawnBot(
      { host: state.host, port: state.port, username: state.username, authMode: state.authMode, version: state.version },
      sessionId
    );

    sessions.set(sessionId, { bot, state });

    // Reconnection interval
    state.reconnectInterval = setInterval(() => {
      const s = sessions.get(sessionId);
      if (!s) return;
      const notConnected = !s.bot || !s.bot._client || s.bot._client.ended;
      if (s.state.status !== "offline" && notConnected) {
        console.log(`[${sessionId}] Reconnecting...`);
        s.bot = spawnBot(
          { host: s.state.host, port: s.state.port, username: s.state.username, authMode: s.state.authMode, version: s.state.version },
          sessionId
        );
      }
    }, 30 * 60 * 1000);

    // Duration timer
    if (state.durationMinutes) {
      state.stopTimer = setTimeout(() => {
        console.log(`[${sessionId}] Duration reached, stopping.`);
        stopBot(sessionId);
      }, state.durationMinutes * 60 * 1000);
    }

    res.json({ message: "Bot starting", state: publicState(sessionId) });
  } catch (err) {
    console.error(`[${sessionId}] Spawn error:`, err);
    const errorCode = mapErrorToCode(err);
    res.status(500).json({ error: errorCode });
  }
});
 
// ---- API: stop a specific user's bot ----
app.post("/api/bot/stop", (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  stopBot(sessionId);
  res.json({ message: "Bot stopped", state: publicState(sessionId) });
});
 
// ---- API: status for a specific session ----
app.get("/api/bot/status", (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: "sessionId required" });
  res.json(publicState(sessionId));
});
 
// ---- API: how many bots are currently running (global, for capacity display) ----
app.get("/api/bot/count", (req, res) => {
  res.json({ active: sessions.size, max: MAX_CONCURRENT_BOTS });
});
 
function publicState(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { status: "offline" };
  
  // Translate error code to Uzbek message for frontend
  let lastErrorDisplay = null;
  if (s.state.lastError) {
    const errorMap = {
      "connection_refused": "Server ulanishni rad etdi",
      "dns_error": "Server manzilini topib bo'lmadi",
      "timeout": "Ulanish vaqti tugadi",
      "server_unreachable": "Server mavjud emas",
      "network_error": "Tarmoq xatosi",
      "connection_lost": "Ulanish yo'qoldi",
      "kicked_by_server": "Server chiqarib tashladi",
      "whitelist_denied": "Whitelist'da emasiz",
      "banned": "Bu serverda bloklangansiz",
      "kicked_outdated_client": "Client eski versiyada",
      "authentication_failed": "Autentifikatsiya muvaffaqiyatsiz",
      "server_error": "Server xatosi",
    };
    lastErrorDisplay = errorMap[s.state.lastError] || s.state.lastError;
  }
  
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
    lastError: lastErrorDisplay,
  };
}
 
app.listen(PORT, () => {
  console.log(`Minecraft bot backend running on port ${PORT}`);
});
