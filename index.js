const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const rooms = {};
const MAX_ROUNDS = 5;
const MAX_PLAYERS = 4;

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// ─── COLOR DUEL ────────────────────────────────────────────────────────────

const COLORS = [
  { name: "red",    display: "RED",    hex: "#ef4444" },
  { name: "blue",   display: "BLUE",   hex: "#3b82f6" },
  { name: "green",  display: "GREEN",  hex: "#22c55e" },
  { name: "yellow", display: "YELLOW", hex: "#eab308" },
  { name: "purple", display: "PURPLE", hex: "#a855f7" },
  { name: "orange", display: "ORANGE", hex: "#f97316" },
];

function startColorDuel(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.gameState = {
    scores: {},
    round: 0,
    maxRounds: MAX_ROUNDS,
    currentColor: null,
    roundActive: false,
    roundWinner: null,
  };
  room.players.forEach((id) => (room.gameState.scores[id] = 0));
  io.to(roomCode).emit("game_started", { game: "color-duel" });
  setTimeout(() => nextColorRound(roomCode), 1200);
}

function nextColorRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;
  room.gameState.round++;
  room.gameState.roundActive = false;
  room.gameState.roundWinner = null;

  if (room.gameState.round > room.gameState.maxRounds) {
    endGame(roomCode);
    return;
  }

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  room.gameState.currentColor = color;
  io.to(roomCode).emit("color_round_ready", {
    round: room.gameState.round,
    maxRounds: room.gameState.maxRounds,
  });

  const delay = Math.floor(Math.random() * 2000) + 1000;
  setTimeout(() => {
    if (!rooms[roomCode]?.gameState) return;
    room.gameState.roundActive = true;
    io.to(roomCode).emit("color_shown", { color, round: room.gameState.round });
  }, delay);
}

// ─── ROCK PAPER SCISSORS (N-player all-vs-all) ─────────────────────────────

const RPS_BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };

function startRPS(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.gameState = {
    scores: {},
    round: 1,
    maxRounds: MAX_ROUNDS,
    choices: {},
    roundActive: true,
    submittedCount: 0,
  };
  room.players.forEach((id) => (room.gameState.scores[id] = 0));
  io.to(roomCode).emit("game_started", { game: "rps" });
  setTimeout(() =>
    io.to(roomCode).emit("rps_round_start", {
      round: 1,
      maxRounds: MAX_ROUNDS,
      playerCount: room.players.length,
    }), 1200);
}

function resolveRPSRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.gameState) return;

  const gs = room.gameState;
  const players = room.players;
  const choices = gs.choices;

  // Round points earned this round per player
  const roundPoints = {};
  players.forEach((id) => (roundPoints[id] = 0));

  // All-vs-all: compare every unique pair
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const ca = choices[a];
      const cb = choices[b];
      if (RPS_BEATS[ca] === cb) {
        roundPoints[a]++;
        gs.scores[a]++;
      } else if (RPS_BEATS[cb] === ca) {
        roundPoints[b]++;
        gs.scores[b]++;
      }
      // tie → no points
    }
  }

  gs.roundActive = false;

  io.to(roomCode).emit("rps_round_result", {
    choices,
    roundPoints,
    scores: gs.scores,
    playerNames: room.playerNames,
    round: gs.round,
    playerCount: players.length,
  });

  gs.choices = {};
  gs.submittedCount = 0;
  gs.round++;

  if (gs.round > gs.maxRounds) {
    setTimeout(() => endGame(roomCode), 2800);
  } else {
    setTimeout(() => {
      if (!rooms[roomCode]) return;
      gs.roundActive = true;
      io.to(roomCode).emit("rps_round_start", {
        round: gs.round,
        maxRounds: gs.maxRounds,
        playerCount: players.length,
      });
    }, 2800);
  }
}

// ─── SHARED END ────────────────────────────────────────────────────────────

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const scores = room.gameState.scores;

  let maxScore = -1;
  Object.values(scores).forEach((s) => { if (s > maxScore) maxScore = s; });
  const topPlayers = Object.keys(scores).filter((id) => scores[id] === maxScore);
  const winner = topPlayers.length === 1 ? topPlayers[0] : null;

  io.to(roomCode).emit("game_over", {
    scores,
    winner,
    playerNames: room.playerNames,
    draw: winner === null,
  });
}

// ─── SOCKET EVENTS ─────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("🔌 Connected:", socket.id);

  socket.on("create_room", ({ game, playerName }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      game,
      players: [socket.id],
      playerNames: { [socket.id]: playerName || "Player 1" },
      hostId: socket.id,
      gameState: null,
    };
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.emit("room_created", {
      roomCode,
      playerId: socket.id,
      playerNames: rooms[roomCode].playerNames,
      hostId: socket.id,
    });
    console.log(`🏠 Room ${roomCode} created | game: ${game}`);
  });

  socket.on("join_room", ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit("room_error", { message: "Room not found! Check your code." });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit("room_error", { message: "Room is full! (max 4 players)" });
      return;
    }
    if (room.gameState) {
      socket.emit("room_error", { message: "Game already in progress!" });
      return;
    }

    const playerNumber = room.players.length + 1;
    room.players.push(socket.id);
    room.playerNames[socket.id] = playerName || `Player ${playerNumber}`;
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    io.to(roomCode).emit("player_joined", {
      players: room.players,
      playerNames: room.playerNames,
      hostId: room.hostId,
    });
    // Tell the joining socket their own identity so the frontend can transition to 'waiting'
    socket.emit("room_joined", {
      roomCode,
      playerId: socket.id,
      playerNames: room.playerNames,
      players: room.players,
      hostId: room.hostId,
    });
    console.log(`👥 Player joined room ${roomCode} (${room.players.length}/${MAX_PLAYERS})`);
  });

  // ── Host starts the game manually
  socket.on("start_game", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (room.hostId !== socket.id) {
      socket.emit("room_error", { message: "Only the host can start the game." });
      return;
    }
    if (room.players.length < 2) {
      socket.emit("room_error", { message: "Need at least 2 players to start." });
      return;
    }
    if (room.gameState) return;

    let count = 3;
    const countdown = setInterval(() => {
      io.to(roomCode).emit("game_countdown", { count });
      count--;
      if (count < 0) {
        clearInterval(countdown);
        if (room.game === "color-duel") startColorDuel(roomCode);
        else if (room.game === "rps") startRPS(roomCode);
      }
    }, 1000);
  });

  // ── Color Duel: player clicks a color
  socket.on("color_click", ({ color }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room?.gameState) return;

    if (!room.gameState.roundActive) {
      socket.emit("too_late", {});
      return;
    }

    const correct = room.gameState.currentColor.name === color;
    if (correct) {
      if (room.gameState.roundWinner) return;
      room.gameState.roundWinner = socket.id;
      room.gameState.roundActive = false;
      room.gameState.scores[socket.id]++;
      io.to(roomCode).emit("color_round_result", {
        winner: socket.id,
        color: room.gameState.currentColor,
        scores: room.gameState.scores,
        playerNames: room.playerNames,
        round: room.gameState.round,
      });
      setTimeout(() => nextColorRound(roomCode), 2500);
    } else {
      room.gameState.scores[socket.id] = Math.max(0, room.gameState.scores[socket.id] - 1);
      socket.emit("wrong_color", { scores: room.gameState.scores });
      io.to(roomCode).emit("score_update", {
        scores: room.gameState.scores,
        playerNames: room.playerNames,
      });
    }
  });

  // ── RPS: player makes a choice
  socket.on("rps_choice", ({ choice }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room?.gameState?.roundActive) return;
    if (room.gameState.choices[socket.id]) return; // already submitted

    room.gameState.choices[socket.id] = choice;
    room.gameState.submittedCount++;

    // Tell everyone how many have submitted (without revealing choices)
    io.to(roomCode).emit("rps_submission_update", {
      submittedCount: room.gameState.submittedCount,
      totalPlayers: room.players.length,
      submittedIds: Object.keys(room.gameState.choices),
    });

    socket.emit("choice_confirmed", { choice });

    // All players submitted → resolve
    if (room.gameState.submittedCount === room.players.length) {
      room.gameState.roundActive = false;
      resolveRPSRound(roomCode);
    }
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (roomCode && rooms[roomCode]) {
      socket.to(roomCode).emit("player_left", { message: "A player disconnected." });
      delete rooms[roomCode];
      console.log(`❌ Room ${roomCode} closed`);
    }
    console.log("🔌 Disconnected:", socket.id);
  });
});

app.get("/", (req, res) =>
  res.json({
    status: "🎮 MiniGames Backend Running",
    rooms: Object.keys(rooms).length,
  }),
);

const PORT = 3205;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 MiniGames Backend on http://localhost:${PORT}`),
);
