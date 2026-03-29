"use strict";

const http               = require("http");
const WebSocket          = require("ws");
const Y                  = require("yjs");
const syncProtocol       = require("y-protocols/sync");
const awarenessProtocol  = require("y-protocols/awareness");
const encoding           = require("lib0/encoding");
const decoding           = require("lib0/decoding");

/* ─── Config ──────────────────────────────────────────────────────────── */

const PORT              = Number(process.env.PORT)  || 3001;
const HOST              = process.env.HOST           || "0.0.0.0";
// Set ALLOWED_ORIGIN to your frontend domain in production, e.g. "https://myapp.com"
// Comma-separate multiple origins: "https://app.com,https://staging.app.com"
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || "*";
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_LENGTH   = 500;
const MAX_ROOM_ID_LEN   = 64;
const PING_INTERVAL_MS  = 30_000;
const ROOM_TTL_MS       = 60_000;

/* ─── y-websocket protocol constants ─────────────────────────────────── */
const MSG_SYNC            = 0;
const MSG_AWARENESS       = 1;
const MSG_QUERY_AWARENESS = 3;

/* ─── Utilities ───────────────────────────────────────────────────────── */

function sanitizeRoomId(raw) {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, "").slice(0, MAX_ROOM_ID_LEN);
  return id.length > 0 ? id : null;
}

function sanitizeName(raw) {
  return String(raw || "Anonymous").replace(/[<>"'&]/g, "").slice(0, 32).trim() || "Anonymous";
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGIN === "*") return true;
  if (!origin) return false;
  return ALLOWED_ORIGIN.split(",").map(s => s.trim()).includes(origin);
}

/* ─── Room registry ───────────────────────────────────────────────────── */

/**
 * Each room holds:
 *   ydoc              — authoritative Y.Doc for this room
 *   awareness         — server-side Awareness instance (tracks all client states)
 *   clientAwarenessIds — Map<WebSocket, number>: ws → Yjs clientID
 *                        so we clean up the RIGHT awareness state on disconnect
 *   chat              — recent message history (capped)
 *   clients           — all connected WebSocket instances
 *   gcTimer           — deferred cleanup handle
 */
const rooms = new Map();

function getRoom(roomId) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    if (room.gcTimer) { clearTimeout(room.gcTimer); room.gcTimer = null; }
    return room;
  }

  const ydoc = new Y.Doc({ gc: true });
  const awareness = new awarenessProtocol.Awareness(ydoc);

  // FIX 3 — awareness broadcast must NOT echo back to the sender.
  // We pass the originating ws as `origin` when calling applyAwarenessUpdate,
  // and skip that ws in the fan-out here.
  awareness.on("update", ({ added, updated, removed }, originWs) => {
    const changedClients = [...added, ...updated, ...removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
    );
    const msg = encoding.toUint8Array(encoder);

    const room = rooms.get(roomId);
    if (!room) return;
    for (const client of room.clients) {
      if (client === originWs) continue; // skip sender
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });

  const room = {
    ydoc,
    awareness,
    clientAwarenessIds: new Map(),
    clients: new Set(),
    gcTimer: null,
  };
  rooms.set(roomId, room);
  console.log(`[room] Created "${roomId}"`);
  return room;
}

function scheduleRoomGC(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.clients.size > 0) return;
  room.gcTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (r && r.clients.size === 0) {
      r.awareness.destroy();
      r.ydoc.destroy();
      rooms.delete(roomId);
      console.log(`[room] GC'd "${roomId}"`);
    }
  }, ROOM_TTL_MS);
}

/* ─── y-websocket protocol helpers ───────────────────────────────────── */

function sendSyncStep1(ws, ydoc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(encoder, ydoc);
  ws.send(encoding.toUint8Array(encoder));
}

function sendSyncStep2(ws, ydoc) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_SYNC);
  syncProtocol.writeSyncStep2(encoder, ydoc, Y.encodeStateAsUpdate(ydoc));
  ws.send(encoding.toUint8Array(encoder));
}

function sendAwarenessInit(ws, awareness) {
  const clients = Array.from(awareness.getStates().keys());
  if (clients.length === 0) return;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MSG_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients)
  );
  ws.send(encoding.toUint8Array(encoder));
}

/**
 * Handle all binary Yjs protocol messages.
 *
 * FIX 1 — binary detection: Don't use the second `isBinary` argument from ws.
 *   In ws@7+ the signature is message(data, isBinary) but in earlier versions
 *   it's just message(data). We check the data type directly instead.
 *
 * FIX 2 — awareness clientID tracking: We decode the Yjs clientID out of each
 *   incoming awareness update and store the ws→clientID mapping so that on
 *   disconnect we remove THAT client's state — not the server doc's own ID.
 *
 * FIX 3 — no echo: Pass ws as the origin to applyAwarenessUpdate so the
 *   awareness "update" listener can exclude the sender from rebroadcast.
 */
function handleBinaryMessage(ws, room, buffer) {
  try {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const decoder = decoding.createDecoder(data);
    const msgType = decoding.readVarUint(decoder);

    if (msgType === MSG_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      const syncMsgType = syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, ws);

      // Reply to sender (e.g. our sync step2 in response to their step1)
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder));
      }

      // Fan-out doc updates to all other clients in the room
      if (
        syncMsgType === syncProtocol.messageYjsSyncStep2 ||
        syncMsgType === syncProtocol.messageYjsUpdate
      ) {
        broadcastBinary(room, data, ws);
      }
      return;
    }

    if (msgType === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);

      // Extract and store this client's Yjs clientID from their awareness payload
      try {
        const d2 = decoding.createDecoder(update);
        const numClients = decoding.readVarUint(d2);
        if (numClients > 0 && !room.clientAwarenessIds.has(ws)) {
          const yjsClientId = decoding.readVarUint(d2);
          room.clientAwarenessIds.set(ws, yjsClientId);
        }
      } catch (_) { /* non-critical */ }

      // Apply update; pass ws as origin so broadcast handler skips the sender
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
      return;
    }

    if (msgType === MSG_QUERY_AWARENESS) {
      sendAwarenessInit(ws, room.awareness);
    }
  } catch (_) {
    // Malformed message — silently discard
  }
}

/* ─── Broadcast helpers ───────────────────────────────────────────────── */

function broadcastBinary(room, data, excludeWs = null) {
  for (const client of room.clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

function broadcastJson(room, msg, excludeWs = null) {
  const payload = JSON.stringify(msg);
  for (const client of room.clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

/* ─── HTTP server ─────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const allowOrigin = ALLOWED_ORIGIN === "*" ? "*" : (isOriginAllowed(origin) ? origin : "null");

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", uptime: Math.floor(process.uptime()) }));
    return;
  }

  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      rooms: rooms.size,
      clients: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
      roomList: [...rooms.entries()].map(([id, r]) => ({
        id, clients: r.clients.size,
      })),
    }, null, 2));
    return;
  }

  res.writeHead(404); res.end();
});

/* ─── WebSocket server ────────────────────────────────────────────────── */

// FIX 4 — verifyClient: browsers send an Origin header on every WS upgrade.
// Without this, the ws library uses its default which may reject cross-origin
// connections silently, causing connections from other tabs/windows/domains to
// fail at the HTTP upgrade before they ever reach our "connection" handler.
const wss = new WebSocket.Server({
  server,
  clientTracking: false,
  verifyClient: ({ origin }, cb) => {
    if (isOriginAllowed(origin || "*")) {
      cb(true);
    } else {
      console.warn(`[ws] Rejected origin: ${origin}`);
      cb(false, 403, "Forbidden");
    }
  },
});

wss.on("connection", (ws, req) => {
  // Parse + validate
  const url     = new URL(req.url, "http://localhost");
  const rawRoom = url.pathname.replace(/^\/+/, "") || url.searchParams.get("room") || "default";
  const roomId  = sanitizeRoomId(rawRoom);

  if (!roomId) { ws.close(1008, "Invalid room ID"); return; }

  const userName = sanitizeName(url.searchParams.get("name"));

  // Join room
  const room = getRoom(roomId);
  room.clients.add(ws);

  // Yjs handshake: send step1 (our state vector) + step2 (full state)
  sendSyncStep1(ws, room.ydoc);
  sendSyncStep2(ws, room.ydoc);
  // Send existing awareness states (other users' cursors)
  sendAwarenessInit(ws, room.awareness);

  // Send session metadata (just userName now — chat history lives in Y.Array)
  ws.send(JSON.stringify({ type: "init", payload: { userName } }));

  broadcastJson(room, { type: "user_joined", payload: { name: userName } }, ws);
  console.log(`[+] "${userName}" → "${roomId}" (${room.clients.size} online)`);

  // Heartbeat
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // FIX 1 — detect binary by data type, not by the isBinary argument
  ws.on("message", (raw) => {
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || ArrayBuffer.isView(raw)) {
      handleBinaryMessage(ws, room, raw);
      return;
    }

    // All chat is now synced via Y.Array on the Yjs doc — no JSON chat handler needed.
  });

  ws.on("close", () => {
    room.clients.delete(ws);

    // FIX 2 — remove the correct client's awareness state using their actual
    // Yjs clientID (stored when we first saw their awareness update), NOT
    // room.ydoc.clientID which is the SERVER's own ID and would corrupt the doc.
    const yjsClientId = room.clientAwarenessIds.get(ws);
    if (yjsClientId !== undefined) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [yjsClientId], null);
      room.clientAwarenessIds.delete(ws);
    }

    broadcastJson(room, { type: "user_left", payload: { name: userName } });
    console.log(`[-] "${userName}" ← "${roomId}" (${room.clients.size} online)`);
    scheduleRoomGC(roomId);
  });

  ws.on("error", (e) => {
    console.error(`[ws] "${userName}" in "${roomId}":`, e.message);
    ws.terminate();
  });
});

/* ─── Heartbeat ───────────────────────────────────────────────────────── */

const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, PING_INTERVAL_MS);

/* ─── Graceful shutdown ───────────────────────────────────────────────── */

function shutdown(signal) {
  console.log(`\n[server] ${signal} — shutting down`);
  clearInterval(heartbeat);
  for (const room of rooms.values()) {
    for (const ws of room.clients) ws.close(1001, "Server shutting down");
    room.awareness.destroy();
    room.ydoc.destroy();
  }
  rooms.clear();
  server.close(() => { console.log("[server] Closed"); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException",  e => console.error("[uncaughtException]", e));
process.on("unhandledRejection", e => console.error("[unhandledRejection]", e));

/* ─── Start ───────────────────────────────────────────────────────────── */

server.listen(PORT, HOST, () => {
  console.log(`\n🚀  Yjs Collaborative Editor Server`);
  console.log(`    WebSocket : ws://${HOST}:${PORT}`);
  console.log(`    Health    : http://${HOST}:${PORT}/health`);
  console.log(`    Metrics   : http://${HOST}:${PORT}/metrics`);
  console.log(`    Origins   : ${ALLOWED_ORIGIN}`);
  console.log(`    Room TTL  : ${ROOM_TTL_MS / 1000}s\n`);
});