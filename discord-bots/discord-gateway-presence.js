#!/usr/bin/env node

const DEFAULT_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

function resolveWebSocketClass() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  try {
    // Optional fallback for older Node versions if ws is installed.
    // eslint-disable-next-line global-require
    return require("ws");
  } catch {
    return null;
  }
}

function startDiscordPresence(options = {}) {
  const token = String(options.token || "").trim();
  const intents = Number.isFinite(options.intents) ? Number(options.intents) : 0;
  const status = String(options.status || "online");
  const logPrefix = String(options.logPrefix || "Discord");
  const gatewayUrl = String(options.gatewayUrl || DEFAULT_GATEWAY);
  const activity = options.activity && typeof options.activity === "object" ? options.activity : null;
  const onDispatch = typeof options.onDispatch === "function" ? options.onDispatch : null;
  const onReady = typeof options.onReady === "function" ? options.onReady : null;
  const onClose = typeof options.onClose === "function" ? options.onClose : null;
  const onFatal = typeof options.onFatal === "function" ? options.onFatal : null;
  const minReconnectDelayMs = Math.max(500, Number(options.minReconnectDelayMs || 1500));
  const maxReconnectDelayMs = Math.max(minReconnectDelayMs, Number(options.maxReconnectDelayMs || 60_000));

  const WebSocketImpl = resolveWebSocketClass();
  if (!token || !WebSocketImpl) {
    if (!WebSocketImpl) {
      console.warn(`${logPrefix}: WebSocket unavailable, presence connection disabled.`);
    }
    return { stop() {} };
  }

  let ws = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let sequence = null;
  let stopped = false;
  let readyLogged = false;
  let reconnectAttempt = 0;

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function safeSend(payload) {
    if (!ws) return;
    if (ws.readyState !== WebSocketImpl.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function heartbeat() {
    safeSend({ op: 1, d: sequence });
  }

  function scheduleReconnect(delayMs) {
    if (stopped) return;
    if (reconnectTimer) return;
    clearHeartbeat();

    let reconnectDelayMs = Number(delayMs);
    if (!Number.isFinite(reconnectDelayMs) || reconnectDelayMs <= 0) {
      const exp = Math.min(8, reconnectAttempt);
      const baseDelay = Math.min(maxReconnectDelayMs, minReconnectDelayMs * (2 ** exp));
      const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(baseDelay * 0.2)));
      reconnectDelayMs = Math.min(maxReconnectDelayMs, baseDelay + jitter);
    }

    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function identify() {
    const activities = activity ? [activity] : [];
    safeSend({
      op: 2,
      d: {
        token,
        intents,
        properties: {
          os: process.platform,
          browser: "antarctic-bot",
          device: "antarctic-bot",
        },
        presence: {
          status,
          since: null,
          afk: false,
          activities,
        },
      },
    });
  }

  function onMessage(raw) {
    let packet = null;
    try {
      packet = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }

    if (!packet || typeof packet !== "object") return;
    if (typeof packet.s !== "undefined" && packet.s !== null) {
      sequence = packet.s;
    }

    if (packet.op === 10 && packet.d && packet.d.heartbeat_interval) {
      clearHeartbeat();
      const interval = Math.max(1000, Number(packet.d.heartbeat_interval));
      heartbeatTimer = setInterval(heartbeat, interval);
      heartbeat();
      identify();
      return;
    }

    if (packet.op === 7) {
      // Reconnect requested by gateway.
      try {
        if (ws && ws.readyState === WebSocketImpl.OPEN) ws.close(1012, "Gateway requested reconnect");
      } catch {
        // Ignore close errors.
      }
      scheduleReconnect(1000);
      return;
    }

    if (packet.op === 9) {
      // Invalid session.
      sequence = null;
      scheduleReconnect(1200);
      return;
    }

    if (packet.t === "READY" && !readyLogged) {
      const user = packet.d && packet.d.user ? packet.d.user : null;
      const username = user && user.username ? user.username : "bot";
      console.log(`${logPrefix}: gateway presence online as ${username}`);
      readyLogged = true;
      reconnectAttempt = 0;
      if (onReady) {
        Promise.resolve(onReady(packet.d || {})).catch((error) => {
          const msg = error && error.message ? error.message : String(error);
          console.warn(`${logPrefix}: onReady handler error: ${msg}`);
        });
      }
    }

    if (packet.op === 0 && packet.t && onDispatch) {
      Promise.resolve(onDispatch(packet.t, packet.d || {})).catch((error) => {
        const msg = error && error.message ? error.message : String(error);
        console.warn(`${logPrefix}: dispatch handler error for ${packet.t}: ${msg}`);
      });
    }
  }

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocketImpl(gatewayUrl);
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      console.warn(`${logPrefix}: gateway connect error: ${msg}`);
      scheduleReconnect(3000);
      return;
    }

    ws.onopen = () => {
      readyLogged = false;
    };

    ws.onmessage = (event) => {
      const payload = event && typeof event.data !== "undefined" ? event.data : event;
      onMessage(payload);
    };

    ws.onerror = () => {
      // Close will trigger reconnect.
    };

    ws.onclose = (event) => {
      ws = null;
      const code = Number(event && typeof event.code !== "undefined" ? event.code : 0);
      const reason = String(event && event.reason ? event.reason : "");

      if (onClose) {
        try {
          onClose({ code, reason, fatal: FATAL_CLOSE_CODES.has(code) });
        } catch {
          // Ignore onClose callback errors.
        }
      }

      if (FATAL_CLOSE_CODES.has(code)) {
        stopped = true;
        clearHeartbeat();
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        const reasonText = reason ? ` (${reason})` : "";
        console.error(`${logPrefix}: gateway closed with fatal code ${code}${reasonText}. Reconnect disabled.`);
        if (onFatal) {
          try {
            onFatal({ code, reason });
          } catch {
            // Ignore onFatal callback errors.
          }
        }
        return;
      }

      scheduleReconnect();
    };
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws && ws.readyState === WebSocketImpl.OPEN) {
        try {
          ws.close(1000, "Antarctic shutdown");
        } catch {
          // Ignore close errors.
        }
      }
      ws = null;
    },
  };
}

module.exports = {
  startDiscordPresence,
};
