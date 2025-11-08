import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(express.json());

// ✅ Allow both local & deployed frontends
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

// ✅ Each room stores user objects instead of just names
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("🟢 User Connected:", socket.id);

  let currentRoom = null;
  let currentUser = null;

  // ------------------------
  // 🔹 JOIN ROOM
  // ------------------------
  socket.on("join", ({ roomId, userName }) => {
    console.log(`👤 ${userName} joined room ${roomId}`);

    currentRoom = roomId;
    currentUser = userName;
    socket.join(roomId);

    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, { users: new Map(), code: "// start code here" });
    }

    const room = rooms.get(roomId);
    room.users.set(socket.id, { name: userName, online: true });

    // Send current code to newly joined user
    socket.emit("codeUpdate", room.code);

    // Notify all users in room
    io.to(roomId).emit(
      "userListUpdate",
      Array.from(room.users.values())
    );

    // 🔔 Notify others
    socket.to(roomId).emit("userNotification", {
      message: `🟢 ${userName} joined the room`,
      type: "join",
    });
  });

  // ------------------------
  // 🔹 CODE SYNC
  // ------------------------
  socket.on("codeChange", ({ roomId, code }) => {
    if (rooms.has(roomId)) {
      rooms.get(roomId).code = code;
      socket.to(roomId).emit("codeUpdate", code);
    }
  });

  // ------------------------
  // 🔹 LANGUAGE CHANGE
  // ------------------------
  socket.on("languageChange", ({ roomId, language }) => {
    io.to(roomId).emit("languageUpdate", language);
  });

  // ------------------------
  // 🔹 TYPING INDICATOR
  // ------------------------
  socket.on("typing", ({ roomId, userName }) => {
    socket.to(roomId).emit("userTyping", userName);
  });

  // ------------------------
  // 🔹 COMPILE CODE
  // ------------------------
  socket.on(
    "compileCode",
    async ({ code, roomId, language, version, input }) => {
      try {
        const response = await axios.post(
          "https://emkc.org/api/v2/piston/execute",
          {
            language,
            version,
            files: [{ content: code }],
            stdin: input,
          }
        );

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

  // ------------------------
  // 🔹 LEAVE ROOM
  // ------------------------
  socket.on("leaveRoom", () => {
    if (currentRoom && currentUser && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);

      io.to(currentRoom).emit(
        "userListUpdate",
        Array.from(room.users.values())
      );

      io.to(currentRoom).emit("userNotification", {
        message: `🔴 ${currentUser} left the room`,
        type: "leave",
      });

      socket.leave(currentRoom);
    }

    currentRoom = null;
    currentUser = null;
  });

  // ------------------------
  // 🔹 DISCONNECT
  // ------------------------
  socket.on("disconnect", () => {
    console.log("🔴 Disconnected:", socket.id);

    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      const user = room.users.get(socket.id);

      if (user) {
        user.online = false;

        io.to(currentRoom).emit(
          "userListUpdate",
          Array.from(room.users.values())
        );

        io.to(currentRoom).emit("userNotification", {
          message: `🔴 ${user.name} disconnected`,
          type: "leave",
        });

        // Cleanup offline users after 10s
        setTimeout(() => {
          const u = room.users.get(socket.id);
          if (u && !u.online) room.users.delete(socket.id);
        }, 10000);
      }
    }
  });
});

// ------------------------
// 🔹 SERVE FRONTEND
// ------------------------
const port = process.env.PORT || 5000;
const __dirname = path.resolve();

app.use(express.static(path.join(__dirname, "/frontend/dist")));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "frontend", "dist", "index.html"));
});

server.listen(port, () =>
  console.log(`🚀 Server running successfully on port ${port}`)
);
