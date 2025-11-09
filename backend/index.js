import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import axios from "axios";
import cors from "cors";
import JSZip from "jszip";
import fs from "fs";

const app = express();
app.use(express.json());

//  Allow both local & deployed frontends
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://codesync-1zeu.onrender.com",
    ],
    methods: ["GET", "POST"],
  })
);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "https://codesync-1zeu.onrender.com",
    ],
    methods: ["GET", "POST"],
  },
});

//  Each room stores { users, files, messages }
const rooms = new Map();

io.on("connection", (socket) => {
  console.log("🟢 User Connected:", socket.id);

  let currentRoom = null;
  let currentUser = null;

  // ------------------------
  //  JOIN ROOM
  // ------------------------
  socket.on("join", ({ roomId, userName }) => {
    console.log(`👤 ${userName} joined room ${roomId}`);

    currentRoom = roomId;
    currentUser = userName;
    socket.join(roomId);

    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Map(),
        files: { "main.js": "// start code here" },
        messages: [], // 💬 chat messages
      });
    }

    const room = rooms.get(roomId);
    room.users.set(socket.id, { name: userName, online: true });

    // Send current files & chat to the new user
    socket.emit("loadFiles", room.files);
    socket.emit("loadChat", room.messages);

    // Notify all users
    io.to(roomId).emit("userListUpdate", Array.from(room.users.values()));

    //  Notify others
    socket.to(roomId).emit("userNotification", {
      message: `🟢 ${userName} joined the room`,
      type: "join",
    });
  });

  // ------------------------
  //  CHAT HANDLING
  // ------------------------
  socket.on("sendMessage", ({ roomId, userName, text }) => {
    if (!rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const message = {
      sender: userName,
      text,
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    room.messages.push(message);

    // Send to all users in the room
    io.to(roomId).emit("receiveMessage", message);
  });

  // ------------------------
  //  CODE SYNC PER FILE
  // ------------------------
  socket.on("codeChange", ({ roomId, fileName, code }) => {
    if (rooms.has(roomId)) {
      const room = rooms.get(roomId);
      room.files[fileName] = code;
      socket.to(roomId).emit("codeUpdate", { fileName, code });
    }
  });

  // ------------------------
  //🔹 FILE MANAGEMENT
  // ------------------------
  socket.on("createFile", ({ roomId, fileName }) => {
    if (rooms.has(roomId)) {
      const files = rooms.get(roomId).files;
      if (!files[fileName]) {
        files[fileName] = "";
        io.to(roomId).emit("loadFiles", files);
      }
    }
  });

  socket.on("deleteFile", ({ roomId, fileName }) => {
    if (rooms.has(roomId)) {
      const files = rooms.get(roomId).files;
      delete files[fileName];
      io.to(roomId).emit("loadFiles", files);
    }
  });

  // ------------------------
  //  LANGUAGE CHANGE
  // ------------------------
  socket.on("languageChange", ({ roomId, language }) => {
    io.to(roomId).emit("languageUpdate", language);
  });

  // ------------------------
  //  TYPING INDICATOR
  // ------------------------
  socket.on("typing", ({ roomId, userName }) => {
    socket.to(roomId).emit("userTyping", userName);
  });

  // ------------------------
  // COMPILE CODE
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
        io.to(roomId).emit("codeResponse", response.data);
      } catch (error) {
        io.to(roomId).emit("codeResponse", {
          run: { output: "Error compiling code. Please try again." },
        });
      }
    }
  );

  // ------------------------
  //  LEAVE ROOM
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
//  DOWNLOAD ZIP ENDPOINT
// ------------------------
app.get("/api/rooms/:roomId/download", async (req, res) => {
  const { roomId } = req.params;
  if (!rooms.has(roomId)) return res.status(404).send("Room not found");

  const { files } = rooms.get(roomId);
  const zip = new JSZip();

  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }

  const zipContent = await zip.generateAsync({ type: "nodebuffer" });
  const zipPath = path.join(process.cwd(), `${roomId}.zip`);
  fs.writeFileSync(zipPath, zipContent);

  res.download(zipPath, `${roomId}.zip`, () => {
    fs.unlinkSync(zipPath);
  });
});

// HEALTH CHECK ENDPOINT here 
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ------------------------
//  SERVE FRONTEND
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
