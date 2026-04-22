const { io: SocketClient } = require("socket.io-client");
const mongoose = require("mongoose");
const crypto = require("crypto");

const MatchSelection = require("../../models/MatchSelection.model");
const MatchData = require("../../models/matchData.model");

let latestPlayerList = [];
let playerListVersion = 0;
let lastProcessedVersion = 0;
let lastPlayerHash = null;

const liveMatchCache = new Map();
const lastHashMap = new Map();

// 🔹 HASH
const quickHash = (obj) =>
  crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");

// 🔹 SOCKET CONNECT
function connectToPubgSocket() {
  const socket = SocketClient("http://localhost:10086", {
    transports: ["websocket"],
    reconnection: true,
  });

  socket.on("connect", () => {
    console.log("✅ PUBG socket connected");
  });

  socket.on("disconnect", (reason) => {
    console.log("❌ Socket disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.log("❌ Socket error:", err.message);
  });

  let debounceTimer;

  socket.on("totalPlayerList", (data) => {
    const players = Array.isArray(data)
      ? data
      : data?.playerInfoList || [];

    if (!players.length) return;

    // 🔥 Only update if real change
    const newHash = quickHash(players);
    if (newHash === lastPlayerHash) return;

    lastPlayerHash = newHash;

    latestPlayerList = players;
    playerListVersion++;

    console.log(`📡 v${playerListVersion} | 👥 ${players.length}`);

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAllMatches, 200);
  });
}

// 🔹 PROCESS ALL MATCHES
async function processAllMatches() {
  if (playerListVersion === lastProcessedVersion) return;
  lastProcessedVersion = playerListVersion;

  const matches = await MatchSelection.find({
    isSelected: true,
    isPollingActive: true,
  });

  if (!matches.length) return;

  let updatedMatches = 0;
  let dbWrites = 0;

  for (const match of matches) {
    const result = await processOneMatch(match);
    if (result.updated) updatedMatches++;
    if (result.saved) dbWrites++;
  }

  console.log(
    `⚙️ Matches:${matches.length} | 🔥 Updated:${updatedMatches} | 💾 Saved:${dbWrites}`
  );
}

// 🔹 PROCESS ONE MATCH
async function processOneMatch(selection) {
  const { matchId, userId } = selection;

  const matchData = await MatchData.findOne({ matchId, userId });
  if (!matchData) return { updated: false, saved: false };

  let hasChanges = false;

  for (const team of matchData.teams) {
    const teamPlayers = latestPlayerList.filter(
      (p) => Number(p.teamId) === Number(team.slot)
    );

    const newPlayers = teamPlayers.map((p) => ({
      ...p,
      _id: new mongoose.Types.ObjectId(),
      uId: String(p.uId),
      teamIdfromApi: team.slot,
      teamId: Number(p.teamId),
      teamName: p.teamName || "",
    }));

    const newHash = quickHash(newPlayers);

    if (team._lastHash !== newHash) {
      team.players = newPlayers;
      team._lastHash = newHash;
      hasChanges = true;
    }
  }

  let saved = false;

  if (hasChanges) {
    await matchData.save();
    saved = true;
  }

  const updated = matchData.toObject();
  const key = `${userId}:${matchId}`;
  const newHash = quickHash(updated);

  if (lastHashMap.get(key) !== newHash) {
    lastHashMap.set(key, newHash);
    liveMatchCache.set(key, updated);

    const io = require("../../socket").getSocket();
    io.emit("liveMatchUpdate", updated);

    return { updated: true, saved };
  }

  return { updated: false, saved };
}

// 🔹 START
function startLiveMatchUpdater() {
  console.log("🚀 Live Match Updater started");

  connectToPubgSocket();

  setInterval(() => {
    if (latestPlayerList.length > 0) {
      processAllMatches();
    }
  }, 3000);

  setInterval(() => {
    if (liveMatchCache.size > 500) {
      liveMatchCache.clear();
      lastHashMap.clear();
      console.log("🧹 Cache cleared");
    }
  }, 60000);
}

module.exports = { startLiveMatchUpdater };