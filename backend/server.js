/**
 * Minecraft AFK Bot — Backend (MULTI-USER VERSION)
 * -------------------------------------------------
 * Express API that starts/stops mineflayer bots on demand.
 * Supports MULTIPLE concurrent bot sessions — each browser/user gets
 * their own isolated bot, tracked by a sessionId sent from the frontend.
 *
 * The FRONTEND (GitHub Pages, static site) calls this API.
 *
 * This must run on a real, always-on machine (Northflank, VPS, etc).
 * It CANNOT run on GitHub Pages, Vercel, or any serverless platform —
 * those don't allow long-lived TCP connections / background processes.
 *
 * ⚠️ Resource note: each mineflayer bot uses a small amount of RAM/CPU.
 * A handful of simple AFK bots (5-10) is fine on a small free-tier
 * container, but this is NOT unlimited — if you expect many concurrent
 * users, you'll need a bigger plan or a cap (see MAX_CONCURRENT_BOTS).
 */

const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MAX_CONCURRENT_BOTS = 20; // simple safety cap, raise/lower as needed

// ---- Multiple sessions: sessionId -> { bot, state } ----
const sessions = new Map();

function freshState() {
  return {
    status: "offline", // offline | connecting | online | reconnecting | error
    host: null,
    port: null,
    username: null,
    authMode: null,
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

function spawnBot({ host, port, username, authMode }, sessionId) {
  const options = {
    host,
    port: port || 25565,
    username: username || "AFKBot",
    version: false, // auto-detect
    auth: authMode === "premium" ? "microsoft" : "offline",
  };

  // For premium accounts, mineflayer/prismarine-auth will need the user
  // to open a Microsoft login link and enter a code (device code flow).
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
    console.log(`[${sessionId}] Connected to ${host}:${port} as ${username}`);
  });

  newBot.on("kicked", (reason) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.state.status = "offline";
    s.state.lastError = `Kicked: ${reason}`;
    console.log(`[${sessionId}] Kicked:`, reason);
  });

  newBot.on("error", (err) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.state.status = "error";
    s.state.lastError = err.message;
    console.log(`[${sessionId}] Error:`, err.message);
  });

  newBot.on("end", () => {
    const s = sessions.get(sessionId);
    if (!s) return; // session was already stopped/deleted on purpose
    if (s.state.status !== "offline") {
      s.state.status = "reconnecting";
      console.log(`[${sessionId}] Disconnected, will retry on next check`);
    }
  });

  return newBot;
}

// ---- API: start a bot (one per sessionId) ----
app.post("/api/bot/start", (req, res) => {
  const { sessionId, host, port, username, authMode, durationMinutes } = req.body;

  if (!sessionId || !host || !username) {
    return res.status(400).json({ error: "sessionId, host and username are required" });
  }

  if (sessions.size >= MAX_CONCURRENT_BOTS && !sessions.has(sessionId)) {
    return res.status(429).json({ error: "Server is at capacity, try again later" });
  }

  if (sessions.has(sessionId)) stopBot(sessionId); // restart cleanly

  const state = freshState();
  state.host = host;
  state.port = port || 25565;
  state.username = username;
  state.authMode = authMode === "premium" ? "premium" : "cracked";
  state.status = "connecting";
  state.startedAt = Date.now();
  state.durationMinutes = durationMinutes ? Number(durationMinutes) : null;

  const bot = spawnBot(
    { host: state.host, port: state.port, username: state.username, authMode: state.authMode },
    sessionId
  );

  sessions.set(sessionId, { bot, state });

  // ---- Auto-reconnect check every 30 minutes (per session) ----
  state.reconnectInterval = setInterval(() => {
    const s = sessions.get(sessionId);
    if (!s) return; // stopped
    const notConnected = !s.bot || !s.bot._client || s.bot._client.ended;
    if (s.state.status !== "offline" && notConnected) {
      console.log(`[${sessionId}] 30-min check: reconnecting...`);
      s.bot = spawnBot(
        { host: s.state.host, port: s.state.port, username: s.state.username, authMode: s.state.authMode },
        sessionId
      );
    }
  }, 30 * 60 * 1000);

  // ---- Optional auto-stop after durationMinutes ----
  if (state.durationMinutes) {
    state.stopTimer = setTimeout(() => {
      console.log(`[${sessionId}] Duration reached, stopping.`);
      stopBot(sessionId);
    }, state.durationMinutes * 60 * 1000);
  }

  res.json({ message: "Bot starting", state: publicState(sessionId) });
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

// ---- API: how many bots are currently running (optional, for admin/debug) ----
app.get("/api/bot/count", (req, res) => {
  res.json({ active: sessions.size, max: MAX_CONCURRENT_BOTS });
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
    startedAt: s.state.startedAt,
    durationMinutes: s.state.durationMinutes,
    msaLogin: s.state.msaLogin,
    lastError: s.state.lastError,
  };
}

app.listen(PORT, () => {
  console.log(`Minecraft bot backend running on port ${PORT}`);
});
