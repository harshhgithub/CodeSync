import { useEffect, useState } from "react";
import "./App.css";
import io from "socket.io-client";
import Editor from "@monaco-editor/react";
import { v4 as uuid } from "uuid";

// Automatically switch between local & production
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
  const [files, setFiles] = useState({}); // 🔥 Multiple files
  const [activeFile, setActiveFile] = useState("main.js");
  const [code, setCode] = useState("// start code here");
  const [users, setUsers] = useState([]);
  const [copySuccess, setCopySuccess] = useState("");
  const [typing, setTyping] = useState("");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [notifications, setNotifications] = useState([]);

  // 🔹 Socket Listeners
  useEffect(() => {
    socket.on("loadFiles", (roomFiles) => {
      setFiles(roomFiles);
      const firstFile = Object.keys(roomFiles)[0];
      setActiveFile(firstFile);
      setCode(roomFiles[firstFile]);
    });

    socket.on("codeUpdate", ({ fileName, code }) => {
      setFiles((prev) => ({ ...prev, [fileName]: code }));
      if (fileName === activeFile) setCode(code);
    });

    socket.on("languageUpdate", setLanguage);
    socket.on("codeResponse", (res) => setOutput(res.run.output));
    socket.on("userListUpdate", (list) => setUsers(list));
    socket.on("userNotification", (notif) => {
      setNotifications((prev) => [...prev, notif]);
      setTimeout(
        () => setNotifications((prev) => prev.slice(1)),
        3000
      );
    });

    socket.on("userTyping", (user) => {
      setTyping(`${user.slice(0, 8)}... is typing`);
      setTimeout(() => setTyping(""), 2000);
    });

    return () => {
      socket.off("loadFiles");
      socket.off("codeUpdate");
      socket.off("languageUpdate");
      socket.off("codeResponse");
      socket.off("userListUpdate");
      socket.off("userNotification");
      socket.off("userTyping");
    };
  }, [activeFile]);

  // Leave room on tab close
  useEffect(() => {
    const handleBeforeUnload = () => socket.emit("leaveRoom");
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

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
    setFiles({});
    setCode("// start code here");
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopySuccess("Copied!");
    setTimeout(() => setCopySuccess(""), 1500);
  };

  const handleCodeChange = (newCode) => {
    setCode(newCode);
    setFiles((prev) => ({ ...prev, [activeFile]: newCode }));
    socket.emit("codeChange", { roomId, fileName: activeFile, code: newCode });
    socket.emit("typing", { roomId, userName });
  };

  const runCode = () => {
    socket.emit("compileCode", { code, roomId, language, version, input });
  };

  const createRoomId = () => setRoomId(uuid());

  // 🔹 File management
  const createFile = () => {
    const fileName = prompt("Enter new file name (e.g., utils.js):");
    if (fileName && !files[fileName]) {
      socket.emit("createFile", { roomId, fileName });
    }
  };

  const deleteFile = (fileName) => {
    if (window.confirm(`Delete ${fileName}?`)) {
      socket.emit("deleteFile", { roomId, fileName });
    }
  };

  const downloadZip = () => {
    window.open(
      `${
        import.meta.env.MODE === "development"
          ? "http://localhost:5000"
          : "https://realtime-code-editor-zwp3.onrender.com"
      }/api/rooms/${roomId}/download`
    );
  };

  // ============================
  // JOIN PAGE
  // ============================
  if (!joined) {
    return (
      <div className="join-page">
        <div className="join-left">
          <img
            src="https://cdn.dribbble.com/users/1162077/screenshots/3848914/programmer.gif"
            alt="Coding Illustration"
            className="join-illustration"
          />
        </div>

        <div className="join-right">
          <div className="brand">
            <h1 className="brand-title">
              <span className="brand-main">Code</span>
              <span className="brand-accent">Sync</span>
            </h1>
            <p className="brand-sub">
              Collaborate. Code. Compile. In Real-Time.
            </p>
          </div>

          <div className="join-form">
            <input
              type="text"
              placeholder="Room ID"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
            <button onClick={createRoomId} className="generate-btn">
              Generate Unique ID
            </button>
            <input
              type="text"
              placeholder="Your Name"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
            />
            <button onClick={joinRoom} className="join-btn">
              Join Room
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============================
  // EDITOR PAGE
  // ============================
  return (
    <div className="editor-container">
      {/* 🔥 Notifications */}
      <div className="notification-container">
        {notifications.map((n, i) => (
          <div key={i} className={`notification ${n.type}`}>
            {n.message}
          </div>
        ))}
      </div>

      <aside className="sidebar">
        <div className="room-info">
          <h2>Room: {roomId}</h2>
          <button onClick={copyRoomId} className="copy-button">
            Copy ID
          </button>
          {copySuccess && <span className="copy-success">{copySuccess}</span>}
        </div>

        {/* 🗂 File Explorer */}
        <div className="file-section">
          <h3>Files</h3>
          <ul>
            {Object.keys(files).map((file) => (
              <li
                key={file}
                className={file === activeFile ? "active-file" : ""}
                onClick={() => {
                  setActiveFile(file);
                  setCode(files[file]);
                }}
              >
                {file}
                <button
                  className="delete-file"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFile(file);
                  }}
                >
                  ✖
                </button>
              </li>
            ))}
          </ul>
          <button className="file-btn" onClick={createFile}>
            ➕ New File
          </button>
          <button className="download-btn" onClick={downloadZip}>
            💾 Download ZIP
          </button>
        </div>

        {/* 👥 User List */}
        <div className="user-list">
          <h3>Users</h3>
          <ul>
            {users.map((u, i) => (
              <li key={i}>
                <span
                  className={`status-dot ${u.online ? "online" : "offline"}`}
                ></span>
                {u.name}
              </li>
            ))}
          </ul>
        </div>

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
        <h3 className="file-title">{activeFile}</h3>
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
          Run
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
