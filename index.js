// server/index.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());

const FRONTENDS = [
  "http://localhost:5173",
  "https://aesthetic-squirrel-5d3516.netlify.app",
  "https://apna-adda-1.onrender.com"
];

app.use(cors({
  origin: (origin, cb) => {
    // allow no-origin (curl/local)
    if (!origin) return cb(null, true);
    if (FRONTENDS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS not allowed"), false);
  },
  credentials: true
}));

// In-memory store (replace with DB in prod)
const rooms = []; // { _id, code, name, gameKey, maxPlayers, hostId, players: [{ userId, name, score }], status, createdAt }
const genId = () => Math.random().toString(36).slice(2,9);
const genCode = () => Math.random().toString(36).slice(2,6).toUpperCase();

// REST endpoints used by client
app.post("/api/rooms", (req, res) => {
  const { name, gameKey, maxPlayers, hostId } = req.body;
  if (!gameKey) return res.status(400).json({ error: "gameKey required" });
  const _id = genId();
  const code = genCode();
  const room = { _id, code, name, gameKey, maxPlayers: maxPlayers || 4, hostId, players: [], status: "waiting", createdAt: Date.now() };
  rooms.push(room);
  res.json(room);
});

app.get("/api/rooms", (req, res) => {
  res.json(rooms);
});

app.get("/api/rooms/:id", (req, res) => {
  const r = rooms.find(x => x._id === req.params.id);
  if (!r) return res.status(404).json({ error: "not found" });
  res.json(r);
});

app.delete("/api/rooms/:id", (req, res) => {
  const idx = rooms.findIndex(x => x._id === req.params.id);
  if (idx >= 0) rooms.splice(idx, 1);
  res.json({ ok: true });
});

// Basic health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Socket server
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTENDS,
    methods: ["GET","POST"],
    credentials: true
  }
});

// Map socket.id -> { roomId, userId }
const socketMap = new Map();

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);

  // Player joins a room by code
  socket.on("joinRoom", ({ code, userId, name }, cb) => {
    try {
      const room = rooms.find(r => r.code === (code||"").toUpperCase());
      if (!room) return cb && cb({ error: "Room not found" });

      // small duplicate-check
      if (!room.players.find(p => p.userId === userId)) {
        room.players.push({ userId, name, score: 0 });
      }

      // join socket.io room for real-time events
      socket.join(`room_${room._id}`);
      socketMap.set(socket.id, { roomId: room._id, userId });

      // inform room clients
      io.to(`room_${room._id}`).emit("roomUpdate", {
        roomId: room._id,
        code: room.code,
        name: room.name,
        gameKey: room.gameKey,
        maxPlayers: room.maxPlayers,
        players: room.players,
        status: room.status
      });

      // inform admins (admin room convention: admin_<roomId>)
      io.to(`admin_${room._id}`).emit("playersUpdate", room.players);

      cb && cb({ ok: true, roomId: room._id });
    } catch (err) {
      console.error("joinRoom err", err);
      cb && cb({ error: "join failed" });
    }
  });

  // Admin joins admin room to watch players
  socket.on("adminJoin", ({ gameId }, cb) => {
    socket.join(`admin_${gameId}`);
    cb && cb({ ok: true });
  });

  // Host starts the room -> server emits roomStarted to room and to App to open the game
  socket.on("startRoom", ({ roomId }, cb) => {
    const room = rooms.find(r => r._id === roomId);
    if (!room) return cb && cb({ error: "room not found" });
    room.status = "active";
    io.to(`room_${roomId}`).emit("roomStarted", { roomId, gameKey: room.gameKey, code: room.code });
    io.to(`admin_${roomId}`).emit("gameStarted", { roomId });
    cb && cb({ ok: true });
  });

  // Admin controls for quiz flow (if using games with questions)
  socket.on("startGame", ({ gameId }, cb) => {
    // for compatibility with game flow that uses /api/games
    io.to(`game_${gameId}`).emit("gameStarted", { gameId });
    cb && cb({ ok: true });
  });

  socket.on("nextQuestion", ({ gameId }, cb) => {
    io.to(`game_${gameId}`).emit("nextQuestion", { gameId });
    cb && cb({ ok: true });
  });

  // Answer submission pattern (players send answer)
  socket.on("submitAnswer", ({ roomId, userId, answer }, cb) => {
    try {
      const room = rooms.find(r => r._id === roomId);
      if (!room) return cb && cb({ error: "room not found" });
      // VERY simple scoring: +10 for any answer (you'll replace with real validation)
      const p = room.players.find(x => x.userId === userId);
      if (p) p.score = (p.score || 0) + 10;
      io.to(`room_${roomId}`).emit("playersUpdate", room.players);
      io.to(`admin_${roomId}`).emit("playersUpdate", room.players);
      cb && cb({ ok: true });
    } catch (err) {
      console.error(err);
      cb && cb({ error: "submit failed" });
    }
  });

  // Clean up on disconnect
  socket.on("disconnect", () => {
    const entry = socketMap.get(socket.id);
    if (entry) {
      const room = rooms.find(r => r._id === entry.roomId);
      if (room) {
        // optionally remove socket's player if you want; here we keep player in list
        io.to(`room_${room._id}`).emit("roomUpdate", {
          roomId: room._id,
          code: room.code,
          name: room.name,
          gameKey: room.gameKey,
          maxPlayers: room.maxPlayers,
          players: room.players,
          status: room.status
        });
        io.to(`admin_${room._id}`).emit("playersUpdate", room.players);
      }
      socketMap.delete(socket.id);
    }
    console.log("socket disconnect", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log("Server listening on", PORT));
