import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(express.json());

//  Allow both local & deployed frontends
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://realtime-code-editor-zwp3.onrender.com",
    ],
    methods: ["GET", "POST"],
  })
);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://realtime-code-editor-zwp3.onrender.com",
    ],
    methods: ["GET", "POST"],
  },
});

//  Each room has: users (Set), code (String), output (String)
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("🟢 User Connected:", socket.id);

  let currentRoom = null;
  let currentUser = null;

  //  Join Room
  socket.on("join", ({ roomId, userName }) => {
    console.log(`${userName} joined room ${roomId}`);

    // Leave old room if needed
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).users.delete(currentUser);
      io.to(currentRoom).emit(
        "userJoined",
        Array.from(rooms.get(currentRoom).users)
      );
      socket.leave(currentRoom);
    }

    currentRoom = roomId;
    currentUser = userName;
    socket.join(roomId);

    // Initialize room if missing
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { users: new Set(), code: "// start code here" });
    }

    // Add user
    rooms.get(roomId).users.add(userName);

    // Send current code to the newly joined user
    socket.emit("codeUpdate", rooms.get(roomId).code);

    // Notify everyone in the room about the updated user list
    io.to(roomId).emit("userJoined", Array.from(rooms.get(roomId).users));
  });

  //  Code Changes (Sync across users)
  socket.on("codeChange", ({ roomId, code }) => {
    if (rooms.has(roomId)) {
      rooms.get(roomId).code = code;
    }
    socket.to(roomId).emit("codeUpdate", code);
  });

  //  Language Change
  socket.on("languageChange", ({ roomId, language }) => {
    io.to(roomId).emit("languageUpdate", language);
  });

  //  Typing Indicator
  socket.on("typing", ({ roomId, userName }) => {
    socket.to(roomId).emit("userTyping", userName);
  });

  //  Code Execution using Piston API
  socket.on(
    "compileCode",
    async ({ code, roomId, language, version, input }) => {
      try {
        const response = await axios.post("https://emkc.org/api/v2/piston/execute", {
          language,
          version,
          files: [{ content: code }],
          stdin: input,
        });

        const output = response.data.run.output || "No output.";
        rooms.get(roomId).output = output;

        io.to(roomId).emit("codeResponse", response.data);
      } catch (error) {
        io.to(roomId).emit("codeResponse", {
          run: { output: "Error compiling code. Please try again." },
        });
      }
    }
  );

  //  Leave Room
  socket.on("leaveRoom", () => {
    if (currentRoom && currentUser && rooms.has(currentRoom)) {
      rooms.get(currentRoom).users.delete(currentUser);
      io.to(currentRoom).emit(
        "userJoined",
        Array.from(rooms.get(currentRoom).users)
      );
      socket.leave(currentRoom);
      currentRoom = null;
      currentUser = null;
    }
  });

  //  Disconnect
  socket.on("disconnect", () => {
    if (currentRoom && currentUser && rooms.has(currentRoom)) {
      rooms.get(currentRoom).users.delete(currentUser);
      io.to(currentRoom).emit(
        "userJoined",
        Array.from(rooms.get(currentRoom).users)
      );
    }
    console.log("🔴 User Disconnected:", socket.id);
  });
});

//  Serve frontend if built
const port = process.env.PORT || 5000;
const __dirname = path.resolve();

app.use(express.static(path.join(__dirname, "/frontend/dist")));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
});

server.listen(port, () =>
  console.log(`🚀 Server running successfully on port ${port}`)
);
