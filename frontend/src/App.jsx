import { useEffect, useState } from "react";
import "./App.css";
import io from "socket.io-client";
import Editor from "@monaco-editor/react";
import { v4 as uuid } from "uuid";

//  Automatically switch between local & production
const socket = io(
  import.meta.env.MODE === "development"
    ? "http://localhost:5000"
    : "https://realtime-code-editor-zwp3.onrender.com"
);

const App = () => {
  const [joined, setJoined] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [userName, setUserName] = useState("");
  const [language, setLanguage] = useState("javascript");
  const [version, setVersion] = useState("*");
  const [code, setCode] = useState("// start code here");
  const [users, setUsers] = useState([]);
  const [copySuccess, setCopySuccess] = useState("");
  const [typing, setTyping] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");

  //  Event Listeners
  useEffect(() => {
    socket.on("userJoined", setUsers);
    socket.on("codeUpdate", setCode);
    socket.on("languageUpdate", setLanguage);
    socket.on("codeResponse", (res) => setOutput(res.run.output));
    socket.on("userTyping", (user) => {
      setTyping(`${user.slice(0, 8)}... is typing`);
      setTimeout(() => setTyping(""), 2000);
    });

    return () => {
      socket.off("userJoined");
      socket.off("codeUpdate");
      socket.off("languageUpdate");
      socket.off("codeResponse");
      socket.off("userTyping");
    };
  }, []);

  //  Handle leaving room before reload
  useEffect(() => {
    const handleBeforeUnload = () => socket.emit("leaveRoom");
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Join / Leave
  const joinRoom = () => {
    if (roomId && userName) {
      socket.emit("join", { roomId, userName });
      setJoined(true);
    }
  };

  const leaveRoom = () => {
    socket.emit("leaveRoom");
    setJoined(false);
    setRoomId("");
    setUserName("");
    setCode("// start code here");
  };

  //  Copy Room ID
  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopySuccess("Copied!");
    setTimeout(() => setCopySuccess(""), 1500);
  };

  //  Code Editing & Typing
  const handleCodeChange = (newCode) => {
    setCode(newCode);
    socket.emit("codeChange", { roomId, code: newCode });
    socket.emit("typing", { roomId, userName });
  };

  //  Run Code
  const runCode = () => {
    socket.emit("compileCode", { code, roomId, language, version, input });
  };

  //  Create new room
  const createRoomId = () => setRoomId(uuid());

  if (!joined) {
    return (
      <div className="join-container">
        <div className="join-form">
          <h1>Join Code Room</h1>
          <input
            type="text"
            placeholder="Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
          />
          <button onClick={createRoomId}>Generate ID</button>
          <input
            type="text"
            placeholder="Your Name"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
          />
          <button onClick={joinRoom}>Join Room</button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-container">
      <aside className="sidebar">
        <div className="room-info">
          <h2>Room: {roomId}</h2>
          <button onClick={copyRoomId} className="copy-button">
            Copy ID
          </button>
          {copySuccess && <span className="copy-success">{copySuccess}</span>}
        </div>

        <h3>Users in Room:</h3>
        <ul>{users.map((u, i) => <li key={i}>{u.slice(0, 8)}...</li>)}</ul>
        <p className="typing-indicator">{typing}</p>

        <select
          className="language-selector"
          value={language}
          onChange={(e) => {
            const lang = e.target.value;
            setLanguage(lang);
            socket.emit("languageChange", { roomId, language: lang });
          }}
        >
          <option value="javascript">JavaScript</option>
          <option value="python">Python</option>
          <option value="java">Java</option>
          <option value="cpp">C++</option>
        </select>

        <button className="leave-button" onClick={leaveRoom}>
          Leave Room
        </button>
      </aside>

      <main className="editor-wrapper">
        <Editor
          height="60%"
          language={language}
          value={code}
          onChange={handleCodeChange}
          theme="vs-dark"
          options={{ minimap: { enabled: false }, fontSize: 14 }}
        />

        <textarea
          placeholder="Enter input here..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="input-console"
        />
        <button className="run-btn" onClick={runCode}>
          Execute
        </button>
        <textarea
          readOnly
          value={output}
          placeholder="Output will appear here..."
          className="output-console"
        />
      </main>
    </div>
  );
};

export default App;
