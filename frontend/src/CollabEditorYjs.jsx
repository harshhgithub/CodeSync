/**
 * CollabEditorYjs.jsx — Production-Ready Real-time Collaborative Editor
 *
 * Install dependencies:
 *   npm install @monaco-editor/react yjs y-websocket y-monaco
 *
 * Features:
 *   - Room lobby: generate unique room IDs or join existing ones
 *   - URL-based room joining (?room=ROOM_ID)
 *   - Shareable room links with clipboard copy
 *   - Persistent username via in-memory session state
 *   - Exponential backoff reconnection
 *   - Yjs CRDT real-time sync with Monaco editor
 *   - Presence awareness with remote cursors
 *   - In-room chat panel
 *   - Language + theme sync across all clients
 *
 * Usage:
 *   import CollabEditorYjs from './CollabEditorYjs';
 *   <CollabEditorYjs wsUrl="ws://localhost:3001" />
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Editor from "@monaco-editor/react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { MonacoBinding } from "y-monaco";

/* ─── Constants ─────────────────────────────────────────────────────────── */

const LANGUAGES = [
  "javascript","typescript","python","java","cpp",
  "csharp","go","rust","html","css","json","markdown",
];

const USER_COLORS = [
  "#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6",
  "#ec4899","#06b6d4","#84cc16","#f97316","#6366f1",
];

/* ─── Utilities ─────────────────────────────────────────────────────────── */

/** Generate a human-friendly room ID: adjective-noun-4digits */
function generateRoomId() {
  const adj = ["swift","bold","calm","keen","wise","bright","clever","sharp","quick","steady"];
  const noun = ["falcon","river","stone","cedar","pulse","anchor","signal","vector","spark","orbit"];
  const rand4 = Math.floor(1000 + Math.random() * 9000);
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = noun[Math.floor(Math.random() * noun.length)];
  return `${a}-${n}-${rand4}`;
}

/** Read ?room= param from current URL */
function getRoomFromUrl() {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("room") || null;
}

/** Update URL without reload */
function setRoomInUrl(roomId) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url.toString());
}

/** Shareable URL for a room */
function getRoomShareUrl(roomId) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

/** Random color from palette */
function randomColor() {
  return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
}

/* ─── Hooks ──────────────────────────────────────────────────────────────── */

/* ─── Cursor Styles ──────────────────────────────────────────────────────── */

function injectCursorStyles(awarenessStates, myClientId) {
  const styleId = "yjs-cursor-styles";
  let el = document.getElementById(styleId);
  if (!el) {
    el = document.createElement("style");
    el.id = styleId;
    document.head.appendChild(el);
  }
  const rules = [];
  for (const [clientId, state] of awarenessStates) {
    if (clientId === myClientId || !state.user) continue;
    const id = String(clientId);
    const color = state.user.color || "#888";
    const name = CSS.escape((state.user.name || "?").charAt(0).toUpperCase());
    rules.push(`
      .yjs-cursor-${id} { border-left: 2px solid ${color}; position: relative; }
      .yjs-cursor-${id}::before {
        content: "${name}";
        background: ${color}; color: #fff;
        font-size: 10px; font-weight: 700;
        border-radius: 3px 3px 3px 0;
        padding: 1px 4px; position: absolute;
        top: -18px; pointer-events: none;
      }
      .yjs-cursor-${id}-sel { background: ${color}33; }
    `);
  }
  el.textContent = rules.join("\n");
}

/* ─── Sub-components ─────────────────────────────────────────────────────── */

function StatusDot({ status }) {
  const map = {
    open:       { color: "#10b981", label: "Connected" },
    connecting: { color: "#f59e0b", label: "Connecting…" },
    closed:     { color: "#ef4444", label: "Reconnecting…" },
  };
  const { color, label } = map[status] || map.closed;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:"var(--fg2)" }}>
      <span style={{
        width:7, height:7, borderRadius:"50%", background:color,
        display:"inline-block",
        boxShadow: status === "open" ? `0 0 0 2px ${color}44` : "none",
        transition: "all 0.3s",
      }} />
      {label}
    </div>
  );
}

function Avatar({ user, size = 26 }) {
  return (
    <div
      title={user.name}
      style={{
        width:size, height:size, borderRadius:"50%", background:user.color,
        display:"flex", alignItems:"center", justifyContent:"center",
        fontSize: size * 0.42, fontWeight:700, color:"#fff",
        border:"2px solid var(--surface)", flexShrink:0,
        transition:"transform 0.2s",
        cursor:"default",
      }}
      onMouseEnter={e => e.currentTarget.style.transform = "scale(1.15)"}
      onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
    >
      {(user.name || "?").charAt(0).toUpperCase()}
    </div>
  );
}

function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <button
      onClick={handleCopy}
      style={{
        background: copied ? "#10b981" : "var(--accent)",
        color:"#fff", border:"none", borderRadius:6,
        padding:"5px 11px", fontSize:12, cursor:"pointer",
        fontWeight:600, transition:"background 0.2s", whiteSpace:"nowrap",
      }}
    >
      {copied ? "✓ Copied!" : label}
    </button>
  );
}

function ChatPanel({ messages, onSend, myName }) {
  const [text, setText] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior:"smooth" });
  }, [messages]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText("");
  };

  const fmt = (ts) =>
    new Date(ts).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

  return (
    <div style={{
      display:"flex", flexDirection:"column", height:"100%",
      borderLeft:"1px solid var(--border)",
    }}>
      <div style={{
        padding:"10px 14px", borderBottom:"1px solid var(--border)",
        fontSize:11, fontWeight:700, color:"var(--fg2)",
        letterSpacing:"0.08em", textTransform:"uppercase",
        background:"var(--surface)",
      }}>
        💬 Chat
      </div>

      <div style={{
        flex:1, overflowY:"auto", padding:"10px 12px",
        display:"flex", flexDirection:"column", gap:10,
      }}>
        {messages.length === 0 && (
          <div style={{ color:"var(--fg3)", fontSize:12, textAlign:"center", marginTop:24, lineHeight:1.6 }}>
            No messages yet.<br />Say hello 👋
          </div>
        )}
        {messages.map((m) => {
          const mine = m.name === myName;
          return (
            <div key={m.id} style={{
              display:"flex", flexDirection:"column",
              alignItems: mine ? "flex-end" : "flex-start", gap:3,
            }}>
              {!mine && (
                <span style={{ fontSize:11, color:m.color, fontWeight:600 }}>{m.name}</span>
              )}
              <div style={{
                background: mine ? "var(--accent)" : "var(--surface2)",
                color: mine ? "#fff" : "var(--fg)",
                borderRadius: mine ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                padding:"6px 10px", fontSize:13, maxWidth:"86%",
                lineHeight:1.45, wordBreak:"break-word",
              }}>
                {m.text}
              </div>
              <span style={{ fontSize:10, color:"var(--fg3)" }}>{fmt(m.ts)}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <div style={{
        padding:"8px 10px", borderTop:"1px solid var(--border)",
        display:"flex", gap:6,
      }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && submit()}
          placeholder="Message…"
          style={{
            flex:1, background:"var(--surface2)",
            border:"1px solid var(--border)", borderRadius:8,
            padding:"6px 10px", fontSize:13,
            color:"var(--fg)", outline:"none",
          }}
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          style={{
            background:"var(--accent)", color:"#fff",
            border:"none", borderRadius:8, padding:"6px 12px",
            fontSize:13, cursor:"pointer", fontWeight:500,
            opacity: text.trim() ? 1 : 0.4, transition:"opacity 0.15s",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

/* ─── Lobby Screen ───────────────────────────────────────────────────────── */

function Lobby({ onJoin, initialRoomId }) {
  const [name, setName] = useState("");
  const [roomId, setRoomId] = useState(initialRoomId || generateRoomId());
  const [color, setColor] = useState(randomColor());
  const [mode, setMode] = useState(initialRoomId ? "join" : "create"); // "create" | "join"
  const [joinInput, setJoinInput] = useState(initialRoomId || "");
  const [nameError, setNameError] = useState("");
  const [roomError, setRoomError] = useState("");

  const handleGenerate = () => {
    const id = generateRoomId();
    setRoomId(id);
  };

  const validate = () => {
    let ok = true;
    if (!name.trim()) { setNameError("Name is required"); ok = false; }
    else setNameError("");
    const target = mode === "create" ? roomId : joinInput;
    if (!target.trim()) { setRoomError("Room ID is required"); ok = false; }
    else setRoomError("");
    return ok;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    const targetRoom = mode === "create" ? roomId.trim() : joinInput.trim();
    setRoomInUrl(targetRoom);
    onJoin({ userName: name.trim(), roomId: targetRoom, userColor: color });
  };

  return (
    <div style={{
      minHeight:"100vh", background:"var(--bg)",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'Berkeley Mono', 'JetBrains Mono', monospace",
      padding:20,
    }}>
      <div style={{
        width:"100%", maxWidth:440,
        background:"var(--surface)", border:"1px solid var(--border)",
        borderRadius:14, overflow:"hidden",
        boxShadow:"0 24px 60px rgba(0,0,0,0.35)",
      }}>
        {/* Header */}
        <div style={{
          background:"linear-gradient(135deg, #1e3a5f 0%, #0f1f35 100%)",
          padding:"28px 28px 20px",
          borderBottom:"1px solid var(--border)",
        }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <span style={{ fontSize:22 }}>⚡</span>
            <span style={{ fontSize:18, fontWeight:700, color:"#e6edf3", letterSpacing:"-0.02em" }}>
              CodeSync
            </span>
          </div>
          <p style={{ fontSize:12, color:"#8b949e", margin:0 }}>
            Real-time collaborative code editor powered by Yjs CRDTs
          </p>
        </div>

        <div style={{ padding:28, display:"flex", flexDirection:"column", gap:20 }}>
          {/* Name input */}
          <div>
            <label style={{ fontSize:11, fontWeight:600, color:"var(--fg2)", letterSpacing:"0.07em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
              Your Name
            </label>
            <div style={{ display:"flex", gap:8 }}>
              <input
                value={name}
                onChange={(e) => { setName(e.target.value); setNameError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                placeholder="e.g. Alice"
                maxLength={32}
                style={{
                  flex:1, background:"var(--surface2)",
                  border:`1px solid ${nameError ? "#ef4444" : "var(--border)"}`,
                  borderRadius:8, padding:"8px 12px",
                  fontSize:13, color:"var(--fg)", outline:"none",
                  transition:"border-color 0.2s",
                }}
                autoFocus
              />
              {/* Color picker */}
              <div style={{ display:"flex", gap:4, flexWrap:"wrap", maxWidth:120 }}>
                {USER_COLORS.slice(0,5).map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    title={c}
                    style={{
                      width:24, height:24, borderRadius:"50%", background:c,
                      border: color === c ? "2px solid #fff" : "2px solid transparent",
                      cursor:"pointer", flexShrink:0,
                      outline: color === c ? `2px solid ${c}` : "none",
                      transition:"transform 0.15s",
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = "scale(1.2)"}
                    onMouseLeave={e => e.currentTarget.style.transform = "scale(1)"}
                  />
                ))}
              </div>
            </div>
            {nameError && <p style={{ color:"#ef4444", fontSize:11, marginTop:4 }}>{nameError}</p>}
          </div>

          {/* Mode tabs */}
          <div style={{
            display:"flex", background:"var(--surface2)",
            borderRadius:8, padding:3,
          }}>
            {["create","join"].map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  flex:1, padding:"7px 0", borderRadius:6, border:"none",
                  background: mode === m ? "var(--accent)" : "transparent",
                  color: mode === m ? "#fff" : "var(--fg2)",
                  fontSize:12, fontWeight:600, cursor:"pointer",
                  transition:"all 0.2s", textTransform:"capitalize",
                  letterSpacing:"0.04em",
                }}
              >
                {m === "create" ? "✦ Create Room" : "→ Join Room"}
              </button>
            ))}
          </div>

          {mode === "create" ? (
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:"var(--fg2)", letterSpacing:"0.07em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
                Room ID
              </label>
              <div style={{ display:"flex", gap:8 }}>
                <input
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g,""))}
                  style={{
                    flex:1, background:"var(--surface2)",
                    border:"1px solid var(--border)", borderRadius:8,
                    padding:"8px 12px", fontSize:13, color:"var(--fg)",
                    outline:"none", fontFamily:"inherit",
                  }}
                  maxLength={48}
                />
                <button
                  onClick={handleGenerate}
                  title="Generate new ID"
                  style={{
                    background:"var(--surface2)", color:"var(--fg2)",
                    border:"1px solid var(--border)", borderRadius:8,
                    padding:"8px 11px", fontSize:14, cursor:"pointer",
                    transition:"color 0.2s",
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = "var(--fg)"}
                  onMouseLeave={e => e.currentTarget.style.color = "var(--fg2)"}
                >
                  🔄
                </button>
              </div>
              <p style={{ fontSize:11, color:"var(--fg3)", marginTop:5 }}>
                Share this ID with collaborators so they can join your room.
              </p>
            </div>
          ) : (
            <div>
              <label style={{ fontSize:11, fontWeight:600, color:"var(--fg2)", letterSpacing:"0.07em", textTransform:"uppercase", display:"block", marginBottom:6 }}>
                Enter Room ID
              </label>
              <input
                value={joinInput}
                onChange={(e) => { setJoinInput(e.target.value.toLowerCase().trim()); setRoomError(""); }}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                placeholder="e.g. swift-falcon-4821"
                style={{
                  width:"100%", background:"var(--surface2)",
                  border:`1px solid ${roomError ? "#ef4444" : "var(--border)"}`,
                  borderRadius:8, padding:"8px 12px", fontSize:13,
                  color:"var(--fg)", outline:"none",
                  boxSizing:"border-box", fontFamily:"inherit",
                }}
                maxLength={48}
              />
              {roomError && <p style={{ color:"#ef4444", fontSize:11, marginTop:4 }}>{roomError}</p>}
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            style={{
              background:"var(--accent)", color:"#fff",
              border:"none", borderRadius:8, padding:"11px 0",
              fontSize:14, fontWeight:700, cursor:"pointer",
              letterSpacing:"0.03em", transition:"opacity 0.2s, transform 0.1s",
            }}
            onMouseEnter={e => e.currentTarget.style.opacity = "0.88"}
            onMouseLeave={e => e.currentTarget.style.opacity = "1"}
            onMouseDown={e => e.currentTarget.style.transform = "scale(0.98)"}
            onMouseUp={e => e.currentTarget.style.transform = "scale(1)"}
          >
            {mode === "create" ? "Create & Enter Room →" : "Join Room →"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Share Modal ────────────────────────────────────────────────────────── */

function ShareModal({ roomId, onClose }) {
  const shareUrl = getRoomShareUrl(roomId);

  return (
    <div
      onClick={onClose}
      style={{
        position:"fixed", inset:0, background:"rgba(0,0,0,0.6)",
        display:"flex", alignItems:"center", justifyContent:"center",
        zIndex:1000, backdropFilter:"blur(4px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background:"var(--surface)", border:"1px solid var(--border)",
          borderRadius:12, padding:24, width:380,
          boxShadow:"0 20px 50px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
          <span style={{ fontWeight:700, fontSize:15, color:"var(--fg)" }}>Share Room</span>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"var(--fg2)", cursor:"pointer", fontSize:18 }}>✕</button>
        </div>

        <div style={{ marginBottom:14 }}>
          <p style={{ fontSize:11, color:"var(--fg2)", marginBottom:6, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.06em" }}>Room ID</p>
          <div style={{ display:"flex", gap:8 }}>
            <code style={{
              flex:1, background:"var(--surface2)", border:"1px solid var(--border)",
              borderRadius:6, padding:"7px 10px", fontSize:13, color:"var(--fg)",
              fontFamily:"monospace", overflow:"hidden", textOverflow:"ellipsis",
              whiteSpace:"nowrap",
            }}>{roomId}</code>
            <CopyButton text={roomId} label="Copy ID" />
          </div>
        </div>

        <div>
          <p style={{ fontSize:11, color:"var(--fg2)", marginBottom:6, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.06em" }}>Invite Link</p>
          <div style={{ display:"flex", gap:8 }}>
            <code style={{
              flex:1, background:"var(--surface2)", border:"1px solid var(--border)",
              borderRadius:6, padding:"7px 10px", fontSize:11, color:"var(--fg3)",
              fontFamily:"monospace", overflow:"hidden", textOverflow:"ellipsis",
              whiteSpace:"nowrap",
            }}>{shareUrl}</code>
            <CopyButton text={shareUrl} label="Copy Link" />
          </div>
        </div>

        <p style={{ fontSize:11, color:"var(--fg3)", marginTop:14 }}>
          Anyone with this link or room ID can join your session. Share it with your collaborators!
        </p>
      </div>
    </div>
  );
}

/* ─── Editor Screen ──────────────────────────────────────────────────────── */

function EditorScreen({ wsUrl, roomId, userName, userColor }) {
  const editorRef = useRef(null);
  const ydocRef = useRef(null);
  const providerRef = useRef(null);
  const bindingRef = useRef(null);

  const [language, setLanguage] = useState("javascript");
  const [users, setUsers] = useState([]);
  const [chat, setChat] = useState([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [theme, setTheme] = useState("vs-dark");
  const [yjsStatus, setYjsStatus] = useState("connecting");
  const [shareOpen, setShareOpen] = useState(false);

  // ── Yjs ────────────────────────────────────────────────────────────────
  // Chat is stored as a Y.Array on the shared doc — no separate WebSocket needed.
  // Any client pushing to ychat triggers an observe() on all other clients.
  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const provider = new WebsocketProvider(`${wsUrl}/${encodeURIComponent(roomId)}`, roomId, ydoc);
    providerRef.current = provider;

    provider.awareness.setLocalStateField("user", { name: userName, color: userColor });
    provider.on("status", ({ status }) => setYjsStatus(status));

    const onAwareness = () => {
      const states = provider.awareness.getStates();
      const online = [];
      for (const [clientId, state] of states) {
        if (state.user) online.push({ id: clientId, name: state.user.name, color: state.user.color });
      }
      setUsers(online);
      injectCursorStyles(states, provider.awareness.clientID);
    };
    provider.awareness.on("change", onAwareness);

    // Language sync via shared map
    const meta = ydoc.getMap("meta");
    if (!meta.get("language")) meta.set("language", "javascript");
    meta.observe(() => { const l = meta.get("language"); if (l) setLanguage(l); });
    setLanguage(meta.get("language") || "javascript");

    // Chat sync via Y.Array — observe fires on every remote or local insert
    const ychat = ydoc.getArray("chat");
    const onChatChange = () => {
      // Keep only the last 200 messages in local state to avoid unbounded growth
      const all = ychat.toArray();
      setChat(all.slice(-200));
    };
    ychat.observe(onChatChange);
    // Hydrate immediately in case we joined a room with existing messages
    setChat(ychat.toArray().slice(-200));

    return () => {
      bindingRef.current?.destroy();
      provider.awareness.off("change", onAwareness);
      ychat.unobserve(onChatChange);
      provider.destroy();
      ydoc.destroy();
    };
  }, [wsUrl, roomId, userName, userColor]);

  const handleEditorDidMount = useCallback((editor) => {
    editorRef.current = editor;
    const ydoc = ydocRef.current;
    const provider = providerRef.current;
    if (!ydoc || !provider) return;
    const ytext = ydoc.getText("code");
    bindingRef.current = new MonacoBinding(
      ytext, editor.getModel(), new Set([editor]), provider.awareness
    );
  }, []);

  const handleLanguageChange = (lang) => {
    ydocRef.current?.getMap("meta").set("language", lang);
  };

  const handleSendChat = (text) => {
    const ydoc = ydocRef.current;
    if (!ydoc) return;
    const ychat = ydoc.getArray("chat");
    ychat.push([{
      id: Math.random().toString(36).slice(2),
      name: userName,
      color: userColor,
      text,
      ts: Date.now(),
    }]);
  };

  const isDark = theme === "vs-dark" || theme === "hc-black";

  return (
    <div style={{
      display:"flex", flexDirection:"column",
      height:"100vh", background:"var(--bg)", color:"var(--fg)",
    }}>
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div style={{
        display:"flex", alignItems:"center", gap:8,
        padding:"0 12px", height:44,
        background:"var(--surface)",
        borderBottom:"1px solid var(--border)",
        flexShrink:0,
      }}>
        {/* App name */}
        <span style={{ fontSize:13, fontWeight:700, color:"var(--fg)", marginRight:4, letterSpacing:"-0.01em" }}>
          ⚡CodeSync
        </span>

        {/* Room badge */}
        <div style={{
          display:"flex", alignItems:"center", gap:6,
          background:"var(--surface2)", borderRadius:6,
          padding:"3px 8px", fontSize:12, fontWeight:600,
          border:"1px solid var(--border)",
        }}>
          <span style={{ width:7, height:7, borderRadius:"50%", background:userColor, display:"inline-block" }} />
          <span style={{ maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            {roomId}
          </span>
        </div>

        {/* Share button */}
        <button
          onClick={() => setShareOpen(true)}
          style={{
            background:"var(--surface2)", color:"var(--fg2)",
            border:"1px solid var(--border)", borderRadius:6,
            padding:"3px 9px", fontSize:11, cursor:"pointer", fontWeight:600,
            transition:"all 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--accent)"; e.currentTarget.style.color = "#fff"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "var(--surface2)"; e.currentTarget.style.color = "var(--fg2)"; }}
        >
          🔗 Share
        </button>

        {/* Yjs status badge */}
        <div style={{
          display:"flex", alignItems:"center", gap:5,
          background: yjsStatus === "connected" ? "#10b98118" : "var(--surface2)",
          border:`1px solid ${yjsStatus === "connected" ? "#10b981" : "var(--border)"}`,
          borderRadius:6, padding:"2px 7px", fontSize:10,
          color: yjsStatus === "connected" ? "#10b981" : "var(--fg3)",
          transition:"all 0.3s",
        }}>
          ⚡ Yjs {yjsStatus === "connected" ? "synced" : yjsStatus}
        </div>

        {/* Language */}
        <select
          value={language}
          onChange={(e) => handleLanguageChange(e.target.value)}
          style={{
            background:"var(--surface2)", color:"var(--fg)",
            border:"1px solid var(--border)", borderRadius:6,
            padding:"3px 7px", fontSize:11, cursor:"pointer", outline:"none",
          }}
        >
          {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>

        {/* Theme */}
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          style={{
            background:"var(--surface2)", color:"var(--fg)",
            border:"1px solid var(--border)", borderRadius:6,
            padding:"3px 7px", fontSize:11, cursor:"pointer", outline:"none",
          }}
        >
          <option value="vs-dark">Dark</option>
          <option value="light">Light</option>
          <option value="hc-black">High Contrast</option>
        </select>

        <div style={{ flex:1 }} />

        {/* Avatars */}
        <div style={{ display:"flex", alignItems:"center", gap:3 }}>
          {users.slice(0,6).map((u) => <Avatar key={u.id} user={u} />)}
          {users.length > 6 && (
            <div style={{
              fontSize:10, color:"var(--fg2)",
              background:"var(--surface2)", borderRadius:12,
              padding:"2px 6px", border:"1px solid var(--border)",
            }}>+{users.length - 6}</div>
          )}
        </div>

        <StatusDot status={yjsStatus === "connected" ? "open" : yjsStatus === "connecting" ? "connecting" : "closed"} />

        {/* Chat toggle */}
        <button
          onClick={() => setChatOpen(p => !p)}
          style={{
            background: chatOpen ? "var(--accent)" : "var(--surface2)",
            color: chatOpen ? "#fff" : "var(--fg2)",
            border:"1px solid var(--border)", borderRadius:6,
            padding:"4px 9px", fontSize:11, cursor:"pointer", fontWeight:600,
            transition:"all 0.15s",
          }}
        >
          💬 Chat
        </button>

        {/* Leave room */}
        <button
          onClick={() => {
            if (window.confirm("Leave this room?")) {
              const url = new URL(window.location.href);
              url.searchParams.delete("room");
              window.history.replaceState({}, "", url.toString());
              window.location.reload();
            }
          }}
          style={{
            background:"transparent", color:"var(--fg3)",
            border:"1px solid var(--border)", borderRadius:6,
            padding:"4px 9px", fontSize:11, cursor:"pointer",
            transition:"all 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.borderColor = "#ef4444"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "var(--fg3)"; e.currentTarget.style.borderColor = "var(--border)"; }}
          title="Leave room"
        >
          ✕ Leave
        </button>
      </div>

      {/* ── Editor + Chat ────────────────────────────────────────────── */}
      <div style={{ flex:1, display:"flex", overflow:"hidden" }}>
        <div style={{ flex:1, overflow:"hidden" }}>
          <Editor
            height="100%"
            language={language}
            theme={theme}
            onMount={handleEditorDidMount}
            defaultValue=""
            options={{
              fontSize: 14,
              fontFamily:'"JetBrains Mono","Fira Code",monospace',
              fontLigatures: true,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              automaticLayout: true,
              padding: { top: 12 },
              cursorBlinking: "smooth",
              smoothScrolling: true,
              renderWhitespace: "selection",
              bracketPairColorization: { enabled: true },
              guides: { indentation: true },
              suggest: { preview: true },
            }}
          />
        </div>
        {chatOpen && (
          <div style={{ width:268, flexShrink:0, overflow:"hidden" }}>
            <ChatPanel messages={chat} onSend={handleSendChat} myName={userName} />
          </div>
        )}
      </div>

      {/* ── Status bar ────────────────────────────────────────────────── */}
      <div style={{
        height:21, background:"var(--accent)",
        display:"flex", alignItems:"center",
        padding:"0 12px", gap:16, fontSize:10, color:"#fff",
        flexShrink:0,
      }}>
        <span>👤 {userName}</span>
        <span>🌐 {roomId}</span>
        <span>👥 {users.length} online</span>
        <div style={{ flex:1 }} />
        <span style={{ opacity:0.75 }}>CodeSync · Yjs CRDT · Real-time</span>
      </div>

      {/* Share modal */}
      {shareOpen && <ShareModal roomId={roomId} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

/* ─── Root Component ─────────────────────────────────────────────────────── */

export default function CollabEditorYjs({ wsUrl = "ws://localhost:3001" }) {
  // Check for ?room= in URL on first render
  const urlRoom = useMemo(() => getRoomFromUrl(), []);

  const [session, setSession] = useState(null); // { userName, roomId, userColor }

  const isDark = true; // always dark for editor
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap');
    :root {
      --bg: #0d1117; --surface: #161b22; --surface2: #21262d;
      --border: #30363d; --fg: #e6edf3; --fg2: #8b949e;
      --fg3: #484f58; --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); font-family: 'JetBrains Mono', monospace; }
    input, select, button { font-family: inherit; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    .yRemoteSelection { background-color: rgba(255,255,255,0.15); }
    .yRemoteSelectionHead {
      position: absolute; border-left: 2px solid; border-top: 2px solid;
      border-color: inherit; height: 100%; box-sizing: border-box;
    }
    .yRemoteSelectionHead::after {
      position: absolute; content: attr(data-label);
      background: inherit; border-color: inherit; color: #fff;
      font-size: 10px; font-weight: 700;
      border-radius: 3px 3px 3px 0; padding: 1px 4px;
      top: -18px; left: -2px; white-space: nowrap; pointer-events: none;
    }
  `;

  return (
    <>
      <style>{css}</style>
      {session ? (
        <EditorScreen wsUrl={wsUrl} {...session} />
      ) : (
        <Lobby onJoin={setSession} initialRoomId={urlRoom} />
      )}
    </>
  );
}