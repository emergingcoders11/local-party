import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import os from "os";
import yts from "yt-search";

// Global exception and rejection handlers to prevent server crashes
process.on("uncaughtException", (err) => {
  console.error("CRITICAL: Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(
    "CRITICAL: Unhandled Promise Rejection at:",
    promise,
    "reason:",
    reason,
  );
});

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Rate Limiting to prevent spammers/bots from overloading search and rooms API
const ipRequestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 30; // Max 30 requests per minute per IP

function rateLimiter(req, res, next) {
  const ip =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
  const now = Date.now();

  if (!ipRequestCounts.has(ip)) {
    ipRequestCounts.set(ip, []);
  }

  const timestamps = ipRequestCounts
    .get(ip)
    .filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  ipRequestCounts.set(ip, timestamps);

  if (timestamps.length > MAX_REQUESTS_PER_MINUTE) {
    console.warn(`Rate limit exceeded for IP: ${ip}`);
    return res
      .status(429)
      .json({ error: "Too many requests. Please try again later." });
  }

  next();
}

// Root Redirect for Browser Requests, API Status for Health Checks
app.get("/", (req, res) => {
  const acceptHeader = req.headers.accept || "";
  if (acceptHeader.includes("text/html")) {
    res.redirect("https://local-party.vercel.app/");
  } else {
    res.json({ status: "ok", service: "local-party-backend" });
  }
});
const rooms = new Map();
const roomDisconnectTimers = new Map();

// Timeouts for inactivity (can be overridden via environment variables for testing)
const INACTIVITY_TIMEOUT_MS = process.env.INACTIVITY_TIMEOUT_MS
  ? parseInt(process.env.INACTIVITY_TIMEOUT_MS, 10)
  : 60 * 60 * 1000; // 1 hour default

const WARNING_TIMEOUT_MS = process.env.WARNING_TIMEOUT_MS
  ? parseInt(process.env.WARNING_TIMEOUT_MS, 10)
  : 2 * 60 * 1000; // 2 minutes default

const inactivityTimers = new Map();
const warningTimers = new Map();

function clearRoomTimers(roomCode) {
  const inactiveTimer = inactivityTimers.get(roomCode);
  if (inactiveTimer) {
    clearTimeout(inactiveTimer);
    inactivityTimers.delete(roomCode);
  }

  const warningTimer = warningTimers.get(roomCode);
  if (warningTimer) {
    clearTimeout(warningTimer);
    warningTimers.delete(roomCode);
  }

  const disconnectTimer = roomDisconnectTimers.get(roomCode);
  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    roomDisconnectTimers.delete(roomCode);
  }
}

function resetRoomActivity(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.lastActivityTime = Date.now();

  // Clear existing timers
  const inactiveTimer = inactivityTimers.get(roomCode);
  if (inactiveTimer) {
    clearTimeout(inactiveTimer);
    inactivityTimers.delete(roomCode);
  }
  const warningTimer = warningTimers.get(roomCode);
  if (warningTimer) {
    clearTimeout(warningTimer);
    warningTimers.delete(roomCode);
  }

  // Schedule warning timer
  const timer = setTimeout(() => {
    triggerInactivityWarning(roomCode);
  }, INACTIVITY_TIMEOUT_MS);
  inactivityTimers.set(roomCode, timer);
}

function triggerInactivityWarning(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // If the room has an active playing song, it is not inactive. Extend the timer.
  if (room.currentSong && room.currentSong.isPlaying) {
    console.log(
      `Room ${roomCode} has active music playback. Extending activity timer.`,
    );
    resetRoomActivity(roomCode);
    return;
  }

  console.log(
    `Room ${roomCode} has been inactive for 1 hour. Broadcasting warning.`,
  );
  io.to(roomCode).emit("room:inactivity-warning", {
    warningTimeoutMs: WARNING_TIMEOUT_MS,
  });

  const timer = setTimeout(() => {
    destroyRoomDueToInactivity(roomCode);
  }, WARNING_TIMEOUT_MS);
  warningTimers.set(roomCode, timer);
}

function destroyRoomDueToInactivity(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  console.log(`Room ${roomCode} destroyed due to inactivity.`);

  clearRoomTimers(roomCode);

  io.to(roomCode).emit("room:destroyed-inactivity");
  rooms.delete(roomCode);
}

function logRoomEvent(room, message) {
  if (!room) return;
  if (!room.auditLog) {
    room.auditLog = [];
  }
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${message}`;
  room.auditLog.push(entry);
  console.log(`[Room ${room.roomCode} LOG] ${message}`);
}

const FALLBACK_SONGS = [
  {
    id: "s1",
    title: "Helix Echoes",
    artist: "SoundHelix Band",
    album: "Electronic Odyssey",
    duration: 372,
    albumArt:
      "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  },
  {
    id: "s2",
    title: "Neon Skyline",
    artist: "SoundHelix Band",
    album: "Retro Waves",
    duration: 425,
    albumArt:
      "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
  },
  {
    id: "s3",
    title: "Sunset Groove",
    artist: "SoundHelix Band",
    album: "Chill Lounge",
    duration: 344,
    albumArt:
      "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
  },
  {
    id: "s4",
    title: "Synthwave Dreams",
    artist: "SoundHelix Band",
    album: "Futuristic Horizon",
    duration: 302,
    albumArt:
      "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
  },
  {
    id: "s5",
    title: "Midnight City",
    artist: "SoundHelix Band",
    album: "Vapor Trails",
    duration: 363,
    albumArt:
      "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
  },
  {
    id: "s6",
    title: "Summer Jam",
    artist: "SoundHelix Band",
    album: "Beach Vibin",
    duration: 312,
    albumArt:
      "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
  },
  {
    id: "s7",
    title: "Deep Bass Quest",
    artist: "SoundHelix Band",
    album: "Sub Woofer",
    duration: 382,
    albumArt:
      "https://images.unsplash.com/photo-1516280440614-37939bbacd6a?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
  },
  {
    id: "s8",
    title: "Cosmic Voyage",
    artist: "SoundHelix Band",
    album: "Galaxy Travel",
    duration: 334,
    albumArt:
      "https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
  },
];

function playFallbackSong(room, roomCode, previousSong) {
  const availableFallbacks = FALLBACK_SONGS.filter(
    (s) =>
      !previousSong || (s.url !== previousSong.url && s.id !== previousSong.id),
  );
  const fallback =
    availableFallbacks.length > 0
      ? availableFallbacks[
          Math.floor(Math.random() * availableFallbacks.length)
        ]
      : FALLBACK_SONGS[Math.floor(Math.random() * FALLBACK_SONGS.length)];

  const autoplaySong = {
    ...fallback,
    id: Math.random().toString(36).substring(2, 9),
    addedBy: "Autoplay Fallback",
    addedAt: Date.now(),
  };

  room.currentSong = {
    ...autoplaySong,
    isPlaying: true,
    progress: 0,
    startTime: Date.now(),
  };

  console.log(
    `[Autoplay Fallback] Playing song: "${autoplaySong.title}" in room ${roomCode}`,
  );
  io.to(roomCode).emit("song:change", room.currentSong);
  logRoomEvent(room, `Autoplay fallback started song: "${autoplaySong.title}"`);
}

async function fillAutoplayQueue(room, roomCode, currentSongOrLastPlayed) {
  if (!room || !currentSongOrLastPlayed) return;
  if (!room.autoplayQueue) room.autoplayQueue = [];

  // If the autoplay queue already has 5 or more songs, we don't need to do anything
  if (room.autoplayQueue.length >= 5) {
    // Send updated autoplay queue to host
    io.to(room.hostSocketId).emit("autoplayQueue:update", room.autoplayQueue);
    return;
  }

  try {
    const query = `${currentSongOrLastPlayed.title} ${currentSongOrLastPlayed.artist || ""} related music`;
    console.log(
      `[Autoplay Queue] Replenishing. Searching related songs for: "${query}"`,
    );

    const r = await yts(query);
    const videos = r.videos || [];

    if (!room.playedHistory) room.playedHistory = [];

    // Filter out videos already in queue, autoplay queue, playedHistory, or active song
    let candidates = videos.filter((v) => {
      const isSelf =
        v.videoId === currentSongOrLastPlayed.url ||
        v.videoId === currentSongOrLastPlayed.id;
      const inHistory = room.playedHistory.includes(v.videoId);
      const inQueue = room.queue.some((q) => q.url === v.videoId);
      const inAutoplay = room.autoplayQueue.some((q) => q.url === v.videoId);
      return !isSelf && !inHistory && !inQueue && !inAutoplay;
    });

    if (candidates.length === 0 && room.playedHistory.length > 0) {
      room.playedHistory = [];
      candidates = videos.filter((v) => {
        const isSelf =
          v.videoId === currentSongOrLastPlayed.url ||
          v.videoId === currentSongOrLastPlayed.id;
        const inQueue = room.queue.some((q) => q.url === v.videoId);
        const inAutoplay = room.autoplayQueue.some((q) => q.url === v.videoId);
        return !isSelf && !inQueue && !inAutoplay;
      });
    }

    const needed = 5 - room.autoplayQueue.length;
    const addedCount = Math.min(needed, candidates.length);

    for (let i = 0; i < addedCount; i++) {
      const v = candidates[i];
      const autoplaySong = {
        id: v.videoId,
        title: v.title,
        artist: (v.author && v.author.name) || "Autoplay Artist",
        album: "Autoplay Related",
        duration: v.seconds || 180,
        albumArt:
          v.thumbnail ||
          v.image ||
          "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
        url: v.videoId,
        addedBy: "Autoplay",
        addedAt: Date.now(),
      };
      room.autoplayQueue.push(autoplaySong);
    }

    // Fallback to pre-defined mock tracks if still empty or deficient
    while (room.autoplayQueue.length < 5) {
      const mock =
        FALLBACK_SONGS[Math.floor(Math.random() * FALLBACK_SONGS.length)];
      room.autoplayQueue.push({
        ...mock,
        id: Math.random().toString(36).substring(2, 9),
        addedBy: "Autoplay Fallback",
        addedAt: Date.now(),
      });
    }

    // Broadcast updated autoplay queue to host
    io.to(room.hostSocketId).emit("autoplayQueue:update", room.autoplayQueue);
  } catch (err) {
    console.error(
      `[Autoplay Queue] Error replenishing queue for room ${roomCode}:`,
      err,
    );
    // Fill with fallback tracks
    while (room.autoplayQueue.length < 5) {
      const mock =
        FALLBACK_SONGS[Math.floor(Math.random() * FALLBACK_SONGS.length)];
      room.autoplayQueue.push({
        ...mock,
        id: Math.random().toString(36).substring(2, 9),
        addedBy: "Autoplay Fallback",
        addedAt: Date.now(),
      });
    }
    io.to(room.hostSocketId).emit("autoplayQueue:update", room.autoplayQueue);
  }
}

async function playRelatedSong(roomCode, previousSong) {
  const room = rooms.get(roomCode);
  if (!room) return;

  try {
    // If a song was added in the queue in the meantime, play that
    if (room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentSong = {
        ...nextSong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now(),
      };
      io.to(roomCode).emit("song:change", room.currentSong);
      io.to(room.hostSocketId).emit("queue:update", room.queue);
      logRoomEvent(room, `Skipped to next queued song: "${nextSong.title}"`);

      // Fill the autoplayQueue based on this new active song!
      fillAutoplayQueue(room, roomCode, room.currentSong);
      return;
    }

    if (!room.playedHistory) {
      room.playedHistory = [];
    }

    if (previousSong && previousSong.url) {
      if (!room.playedHistory.includes(previousSong.url)) {
        room.playedHistory.push(previousSong.url);
      }
      if (room.playedHistory.length > 15) {
        room.playedHistory.shift();
      }
    }

    // Populate autoplayQueue if it's empty
    if (!room.autoplayQueue || room.autoplayQueue.length === 0) {
      await fillAutoplayQueue(room, roomCode, previousSong || room.currentSong);
    }

    if (room.autoplayQueue && room.autoplayQueue.length > 0) {
      const autoplaySong = room.autoplayQueue.shift();
      room.currentSong = {
        ...autoplaySong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now(),
      };

      console.log(
        `[Autoplay] Playing related song: "${autoplaySong.title}" in room ${roomCode}`,
      );
      io.to(roomCode).emit("song:change", room.currentSong);
      logRoomEvent(
        room,
        `Autoplay started related song: "${autoplaySong.title}"`,
      );

      // Asynchronously replenish the autoplayQueue
      fillAutoplayQueue(room, roomCode, room.currentSong);
    } else {
      // Autoplay fallback to SoundHelix mock catalog
      console.log(
        `[Autoplay] No related songs found. Falling back to SoundHelix catalog...`,
      );
      playFallbackSong(room, roomCode, previousSong);
    }
  } catch (err) {
    console.error(
      `[Autoplay] Error finding related song for room ${roomCode}:`,
      err,
    );
    playFallbackSong(room, roomCode, previousSong);
  }
}

// Helper: Get local IPv4 address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    if (!iface) continue;
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (
        alias.family === "IPv4" &&
        alias.address !== "127.0.0.1" &&
        !alias.internal
      ) {
        return alias.address;
      }
    }
  }
  return "localhost";
}

// Helper: Resolve real client IP from Socket handshake (reverse proxy aware)
function getClientIp(socket) {
  const headers =
    socket.handshake && socket.handshake.headers
      ? socket.handshake.headers
      : {};
  const forwarded =
    headers["x-forwarded-for"] ||
    headers["x-real-ip"] ||
    headers["x-client-ip"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  // Prefer connection remoteAddress fields where available (more reliable under some setups)
  const remote =
    (socket.request &&
      socket.request.connection &&
      socket.request.connection.remoteAddress) ||
    (socket.conn && socket.conn.remoteAddress) ||
    socket.handshake.address ||
    "127.0.0.1";

  // Normalize IPv4-mapped IPv6 addresses like ::ffff:192.168.1.5 to plain IPv4
  return typeof remote === "string"
    ? remote.replace(/^::ffff:/, "")
    : "127.0.0.1";
}

const LOCAL_IP = getLocalIpAddress();

// Expose discovery API
app.get("/api/rooms", rateLimiter, (req, res) => {
  const isLocalOnly = req.query.local === "true";
  const clientIp =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";

  let roomList = Array.from(rooms.values());

  if (isLocalOnly) {
    roomList = roomList.filter((room) => {
      // Find host user's IP
      const hostUser = room.users.find((u) => u.isHost);
      const hostIp = hostUser ? hostUser.ip : null;

      if (!hostIp) return false;

      // If client is loopback, match loopback IPs
      const isClientLoopback =
        clientIp === "::1" ||
        clientIp === "127.0.0.1" ||
        clientIp.includes("::ffff:127.0.0.1");
      const isHostLoopback =
        hostIp === "::1" ||
        hostIp === "127.0.0.1" ||
        hostIp.includes("::ffff:127.0.0.1");
      if (isClientLoopback && isHostLoopback) {
        return true;
      }

      // Otherwise, match exact external IPs (which are identical for users sharing NAT/Wi-Fi router)
      const normClientIp = clientIp.replace(/^::ffff:/, "");
      const normHostIp = hostIp.replace(/^::ffff:/, "");
      return normClientIp === normHostIp;
    });
  }

  const activeRooms = roomList.map((room) => ({
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostName: room.hostName,
    userCount: room.users.length,
    isPrivate: !!room.password,
    currentSong: room.currentSong
      ? {
          title: room.currentSong.title,
          artist: room.currentSong.artist,
          albumArt: room.currentSong.albumArt,
          isPlaying: room.currentSong.isPlaying,
        }
      : null,
  }));
  res.json(activeRooms);
});

// Expose local network info API
app.get("/api/network", (req, res) => {
  res.json({ ip: LOCAL_IP });
});

// YouTube Search Cache
const searchCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function extractVideoId(query) {
  const trimmed = query.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const regExp =
    /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]*).*/;
  const match = trimmed.match(regExp);
  if (match && match[2].length === 11) {
    return match[2];
  }
  return null;
}

// Expose YouTube search API
app.get("/api/search", rateLimiter, async (req, res) => {
  const rawQuery = req.query.q || "";
  const trimmedQuery = rawQuery.trim();

  if (!trimmedQuery) {
    return res.json([]);
  }

  // Clear expired cache items
  const now = Date.now();
  for (const [k, v] of searchCache.entries()) {
    if (now - v.timestamp > CACHE_TTL) {
      searchCache.delete(k);
    }
  }

  try {
    // 1. Check if it's a direct YouTube URL or raw Video ID
    const directVideoId = extractVideoId(trimmedQuery);
    if (directVideoId) {
      console.log(`Direct YouTube ID detected: ${directVideoId}`);
      // Check cache first
      const cacheKey = `id:${directVideoId}`;
      if (searchCache.has(cacheKey)) {
        return res.json(searchCache.get(cacheKey).results);
      }

      const video = await yts({ videoId: directVideoId });
      if (video) {
        const result = {
          id: video.videoId,
          title: video.title,
          artist: (video.author && video.author.name) || "Unknown Artist",
          album: "YouTube Video",
          duration: video.seconds || 180,
          albumArt:
            video.thumbnail ||
            video.image ||
            "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
          url: video.videoId,
        };
        const results = [result];
        searchCache.set(cacheKey, { timestamp: now, results });
        return res.json(results);
      }
    }

    // 2. Otherwise do a text search
    // Check text search cache
    const cacheKey = `search:${trimmedQuery.toLowerCase()}`;
    if (searchCache.has(cacheKey)) {
      return res.json(searchCache.get(cacheKey).results);
    }

    // Improve accuracy by appending "music" to search terms if appropriate
    let searchQuery = trimmedQuery;
    const lowerQuery = trimmedQuery.toLowerCase();
    if (
      !lowerQuery.includes("music") &&
      !lowerQuery.includes("song") &&
      !lowerQuery.includes("video") &&
      !lowerQuery.includes("official")
    ) {
      searchQuery = `${trimmedQuery} music`;
    }

    console.log(
      `Searching YouTube for: "${searchQuery}" (original: "${trimmedQuery}")`,
    );
    const r = await yts(searchQuery);
    // Limit to 10 results for faster response and clean UI
    const videos = (r.videos || []).slice(0, 10);
    const results = videos.map((v) => ({
      id: v.videoId,
      title: v.title,
      artist: (v.author && v.author.name) || "Unknown Artist",
      album: "YouTube Video",
      duration: v.seconds || 180,
      albumArt:
        v.thumbnail ||
        v.image ||
        "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
      url: v.videoId,
    }));

    searchCache.set(cacheKey, { timestamp: now, results });
    res.json(results);
  } catch (error) {
    console.error("YouTube search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});

// Expose room audit logs (secured by room password verification)
app.get("/api/rooms/:roomCode/logs", (req, res) => {
  const roomCode = req.params.roomCode?.toUpperCase();
  const password = req.query.password || null;

  const room = rooms.get(roomCode);
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  // Validate room password if private
  if (room.password && room.password !== password) {
    return res
      .status(403)
      .json({ error: "Incorrect room password. Audit logs are protected." });
  }

  res.json({
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostName: room.hostName,
    logs: room.auditLog || [],
  });
});

// Queue Balancing Algorithm
function rebalanceQueue(queue) {
  if (!queue || queue.length <= 1) return queue;

  const userSongsMap = new Map();

  // 1. Group songs by user (preserves initial appearance order of users as Map keys)
  for (const song of queue) {
    if (!userSongsMap.has(song.addedBy)) {
      userSongsMap.set(song.addedBy, []);
    }
    userSongsMap.get(song.addedBy).push(song);
  }

  // 2. Distribute in round-robin fashion
  const rebalanced = [];
  let songsRemaining = true;

  while (songsRemaining) {
    songsRemaining = false;
    for (const [user, songs] of userSongsMap.entries()) {
      if (songs.length > 0) {
        rebalanced.push(songs.shift());
        songsRemaining = true;
      }
    }
  }

  return rebalanced;
}

// Socket.IO logic
io.on("connection", (socket) => {
  let userRoomCode = null;
  let userName = null;

  // Create Room
  socket.on(
    "room:create",
    ({ roomName, hostName, password, permissions }, callback) => {
      // Generate simple 5-digit room code
      let roomCode;
      do {
        roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
      } while (rooms.has(roomCode));

      const defaultPermissions = {
        allowGuestSkip: true,
        allowGuestSeek: false,
        allowGuestPlayPause: true,
        guestMuteByDefault: true,
        displayGuestVideo: false,
      };

      const room = {
        roomCode,
        roomName,
        hostSocketId: socket.id,
        hostName,
        users: [
          {
            socketId: socket.id,
            name: hostName,
            isHost: true,
            ip: getClientIp(socket),
          },
        ],
        currentSong: null,
        queue: [],
        autoplayQueue: [],
        playedHistory: [],
        auditLog: [],
        password: password || null,
        lastActivityTime: Date.now(),
        permissions: {
          ...defaultPermissions,
          ...(permissions || {}),
        },
      };

      rooms.set(roomCode, room);
      userRoomCode = roomCode;
      userName = hostName;
      socket.join(roomCode);
      resetRoomActivity(roomCode);

      logRoomEvent(room, `Room created by ${hostName} ("${roomName}")`);
      if (typeof callback === "function") {
        callback({ success: true, roomCode, room, localIp: LOCAL_IP });
      }
    },
  );

  // Join Room
  socket.on("room:join", ({ roomCode, name, password }, callback) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Room not found" });
      }
      return;
    }

    // Validate password for private rooms
    if (room.password && room.password !== password) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Incorrect room password." });
      }
      return;
    }

    const joinNameRaw = name?.trim() || "";
    if (!joinNameRaw || joinNameRaw.toLowerCase() === "guest") {
      if (typeof callback === "function") {
        callback({
          success: false,
          message: 'A valid name is required to join. "Guest" is not allowed.',
        });
      }
      return;
    }

    const joinName = joinNameRaw;

    // Check if user already in room
    const userExists = room.users.some(
      (u) => u && u.name && u.name.toLowerCase() === joinName.toLowerCase(),
    );
    const finalName = userExists
      ? `${joinName} #${room.users.length + 1}`
      : joinName;

    const newUser = {
      socketId: socket.id,
      name: finalName,
      isHost: false,
      ip: getClientIp(socket),
    };
    room.users.push(newUser);
    userRoomCode = code;
    userName = finalName;
    socket.join(code);

    logRoomEvent(room, `User ${finalName} joined room`);

    // Notify other users
    io.to(code).emit("room:user-update", room.users);
    resetRoomActivity(code);

    // Send success feedback with sanitised room view (no upcoming queue details for guests)
    const clientRoomState = {
      roomCode: room.roomCode,
      roomName: room.roomName,
      hostName: room.hostName,
      users: room.users,
      currentSong: room.currentSong,
      permissions: room.permissions,
    };

    if (typeof callback === "function") {
      callback({
        success: true,
        room: clientRoomState,
        username: finalName,
        localIp: LOCAL_IP,
      });
    }
  });

  // Reconnect to active session
  socket.on(
    "room:reconnect",
    ({ roomCode, role, username, password }, callback) => {
      const code = roomCode?.toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        if (typeof callback === "function") {
          callback({
            success: false,
            message: "Session expired or room not found",
          });
        }
        return;
      }

      // Security: Validate password for private rooms
      if (room.password && room.password !== password) {
        if (typeof callback === "function") {
          callback({ success: false, message: "Incorrect room password." });
        }
        return;
      }

      console.log(
        `Reconnection request: ${username} (${role}) for room: ${code}`,
      );

      // If host is reconnecting, cancel the grace period timer
      if (role === "host") {
        // Security: Verify reconnecting host name matches original host name
        if (username !== room.hostName) {
          if (typeof callback === "function") {
            callback({
              success: false,
              message: "Unauthorized host reconnect request.",
            });
          }
          return;
        }

        const timer = roomDisconnectTimers.get(code);
        if (timer) {
          clearTimeout(timer);
          roomDisconnectTimers.delete(code);
          logRoomEvent(room, `Host reconnected. Grace period cancelled.`);
        } else {
          logRoomEvent(room, `Host reconnected.`);
        }

        room.hostSocketId = socket.id;

        // Update or add host in the users list
        const hostUser = room.users.find((u) => u.isHost);
        if (hostUser) {
          hostUser.socketId = socket.id;
        } else {
          room.users.push({
            socketId: socket.id,
            name: username,
            isHost: true,
            ip: getClientIp(socket),
          });
        }

        // Notify guests that the host is back online
        io.to(code).emit("room:host-status", { connected: true });
      } else {
        // Guest is reconnecting: Security check
        const guestUser = room.users.find((u) => u.name === username);
        if (guestUser) {
          guestUser.socketId = socket.id;
          logRoomEvent(room, `Guest ${username} reconnected.`);
        } else {
          // Guest wasn't in the room before, they cannot bypass normal join
          if (typeof callback === "function") {
            callback({
              success: false,
              message: "User not found in room session. Please join the room.",
            });
          }
          return;
        }
      }

      userRoomCode = code;
      userName = username || (role === "host" ? room.hostName : "Guest");
      socket.join(code);

      // Broadcast updated users list
      io.to(code).emit("room:user-update", room.users);
      resetRoomActivity(code);

      const clientRoomState = {
        roomCode: room.roomCode,
        roomName: room.roomName,
        hostName: room.hostName,
        users: room.users,
        currentSong: room.currentSong,
        permissions: room.permissions,
      };

      if (typeof callback === "function") {
        callback({
          success: true,
          room: clientRoomState,
          username: userName,
          localIp: LOCAL_IP,
          queue: role === "host" ? room.queue : [],
        });
      }
    },
  );

  // Add Song
  socket.on("song:add", ({ song }, callback) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    // Concurrency / Duplicate track suggestion check
    const isDuplicate =
      (room.currentSong &&
        (room.currentSong.url === song.url ||
          room.currentSong.id === song.id)) ||
      room.queue.some(
        (qSong) => qSong.url === song.url || qSong.id === song.id,
      );

    if (isDuplicate) {
      if (typeof callback === "function") {
        callback({
          success: false,
          message: "This song is already playing or in the queue!",
        });
      }
      return;
    }

    const newSong = {
      ...song,
      id: Math.random().toString(36).substring(2, 9),
      addedBy: userName || "Guest",
      addedAt: Date.now(),
    };

    if (!room.currentSong) {
      // If nothing is playing, play immediately
      room.currentSong = {
        ...newSong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now(),
      };

      // Notify all users in the room of the new playing song
      io.to(userRoomCode).emit("song:change", room.currentSong);
      logRoomEvent(
        room,
        `Playing first suggested song: "${newSong.title}" (added by ${newSong.addedBy})`,
      );

      // Asynchronously pre-generate the autoplayQueue
      fillAutoplayQueue(room, userRoomCode, room.currentSong);
    } else {
      // Otherwise put it in the queue
      room.queue.push(newSong);
      room.queue = rebalanceQueue(room.queue);
      logRoomEvent(
        room,
        `Added "${newSong.title}" to queue (suggested by ${newSong.addedBy})`,
      );
    }

    resetRoomActivity(userRoomCode);

    // Notify host of full queue updates
    io.to(room.hostSocketId).emit("queue:update", room.queue);

    // Send success notification to client
    if (typeof callback === "function") {
      callback({ success: true });
    }
  });

  // Play/Pause Song (Host or permitted Guest)
  socket.on("playback:state-change", ({ isPlaying }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    // Enforce host or guest play/pause permissions
    if (
      room.hostSocketId !== socket.id &&
      !room.permissions.allowGuestPlayPause
    ) {
      console.warn(
        `Unauthorized playback state-change request from guest socket: ${socket.id}`,
      );
      return;
    }

    resetRoomActivity(userRoomCode);

    if (room.currentSong) {
      room.currentSong.isPlaying = isPlaying;
      logRoomEvent(
        room,
        `Playback ${isPlaying ? "resumed" : "paused"} by ${room.hostSocketId === socket.id ? "host" : "guest " + userName}`,
      );
      // Broadcast update to everyone
      io.to(userRoomCode).emit("playback:sync", {
        isPlaying,
        progress: room.currentSong.progress,
        songId: room.currentSong.id,
      });
    }
  });

  // Progress Seek (Host or permitted Guest)
  socket.on("playback:seek", ({ progress }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || !room.currentSong) return;

    // Enforce host or guest seek permissions
    if (room.hostSocketId !== socket.id && !room.permissions.allowGuestSeek) {
      console.warn(`Unauthorized seek request from guest socket: ${socket.id}`);
      return;
    }

    resetRoomActivity(userRoomCode);

    room.currentSong.progress = progress;
    logRoomEvent(
      room,
      `Playback seeked to ${Math.round(progress)}s by ${room.hostSocketId === socket.id ? "host" : "guest " + userName}`,
    );
    // Broadcast seek event to everyone in the room
    io.to(userRoomCode).emit("playback:seek", {
      progress,
      isPlaying: room.currentSong.isPlaying,
      songId: room.currentSong.id,
    });
  });

  // Progress Update (Periodically sent by Host)
  socket.on("playback:progress-update", ({ progress, isPlaying }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.currentSong) {
      room.currentSong.progress = progress;
      room.currentSong.isPlaying = isPlaying;

      // Broadcast progress syncing to guests
      socket.to(userRoomCode).emit("playback:sync", {
        isPlaying,
        progress,
        songId: room.currentSong.id,
      });
    }
  });

  // Host or permitted Guest skips song (or song ends and auto-skips)
  socket.on("song:skip", ({ songId } = {}) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    // Enforce host or guest skip permissions
    if (room.hostSocketId !== socket.id && !room.permissions.allowGuestSkip) {
      console.warn(`Unauthorized skip request from guest socket: ${socket.id}`);
      return;
    }

    // Bulletproof skip: Only skip if the request specifies the currently playing songId
    if (songId && room.currentSong && room.currentSong.id !== songId) {
      console.log(
        `Ignoring stale song:skip request for song ID: ${songId}. Current song ID: ${room.currentSong.id}`,
      );
      return;
    }

    const previousSong = room.currentSong;
    logRoomEvent(
      room,
      `Song skipped by ${room.hostSocketId === socket.id ? "host" : "guest " + userName}: "${previousSong ? previousSong.title : "None"}"`,
    );

    if (room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentSong = {
        ...nextSong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now(),
      };
      // Broadcast new state
      io.to(userRoomCode).emit("song:change", room.currentSong);
      // Send updated queue to host
      io.to(room.hostSocketId).emit("queue:update", room.queue);

      // Asynchronously replenish prospective queue based on the new playing song!
      fillAutoplayQueue(room, userRoomCode, room.currentSong);
    } else {
      playRelatedSong(userRoomCode, previousSong);
    }
  });

  // Playback Error reported by Host (e.g. copyright block, embedding disabled)
  socket.on("playback:error", ({ songId, errorCode }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.currentSong && room.currentSong.id === songId) {
      logRoomEvent(
        room,
        `Playback error (${errorCode}) on song "${room.currentSong.title}". Triggering auto-skip.`,
      );

      const previousSong = room.currentSong;

      if (room.queue.length > 0) {
        const nextSong = room.queue.shift();
        room.currentSong = {
          ...nextSong,
          isPlaying: true,
          progress: 0,
          startTime: Date.now(),
        };
        io.to(userRoomCode).emit("song:change", room.currentSong);
        io.to(room.hostSocketId).emit("queue:update", room.queue);
      } else {
        playRelatedSong(userRoomCode, previousSong);
      }
    }
  });

  // Host removes song from queue
  socket.on("song:remove-from-queue", ({ songId }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    resetRoomActivity(userRoomCode);

    const removedSong = room.queue.find((song) => song.id === songId);
    room.queue = room.queue.filter((song) => song.id !== songId);
    logRoomEvent(
      room,
      `Removed song from queue: "${removedSong ? removedSong.title : songId}"`,
    );

    // Update queue list on Host
    io.to(room.hostSocketId).emit("queue:update", room.queue);
  });

  // Host reorders queue list
  socket.on("queue:reorder", ({ queueIds }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    resetRoomActivity(userRoomCode);

    const reorderedQueue = [];
    queueIds.forEach((id) => {
      const song = room.queue.find((q) => q.id === id);
      if (song) reorderedQueue.push(song);
    });

    // Make sure to add back any songs that were missed due to concurrency anomalies
    room.queue.forEach((song) => {
      if (!reorderedQueue.some((q) => q.id === song.id)) {
        reorderedQueue.push(song);
      }
    });

    room.queue = reorderedQueue;
    logRoomEvent(room, "Host reordered active room queue");

    // Broadcast updated queue to host
    io.to(room.hostSocketId).emit("queue:update", room.queue);
  });

  // Host updates active room permissions dynamically
  socket.on("room:update-permissions", ({ permissions }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.permissions = {
      ...room.permissions,
      ...permissions,
    };

    logRoomEvent(
      room,
      `Host updated active room permissions to: ${JSON.stringify(room.permissions)}`,
    );

    // Broadcast updated permissions to everyone in the room
    io.to(userRoomCode).emit("room:permissions-update", room.permissions);
  });

  // Host kicks a user from the room
  socket.on("user:kick", ({ socketId: kickSocketId }, callback) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    resetRoomActivity(userRoomCode);

    const kickedUser = room.users.find((u) => u.socketId === kickSocketId);
    if (!kickedUser || kickedUser.isHost) {
      if (typeof callback === "function") {
        callback({ success: false, message: "Cannot kick this user." });
      }
      return;
    }

    const kickedName = kickedUser.name;
    logRoomEvent(room, `Host kicked user: "${kickedName}"`);

    // Remove user from the room's users list
    room.users = room.users.filter((u) => u.socketId !== kickSocketId);

    // Remove all songs added by the kicked user from the queue
    const prevQueueLength = room.queue.length;
    room.queue = room.queue.filter((song) => song.addedBy !== kickedName);
    if (room.queue.length !== prevQueueLength) {
      logRoomEvent(
        room,
        `Removed ${prevQueueLength - room.queue.length} queue songs suggested by kicked user "${kickedName}"`,
      );
    }

    // If the currently playing song was added by the kicked user, skip it
    if (room.currentSong && room.currentSong.addedBy === kickedName) {
      logRoomEvent(
        room,
        `Skipping current song suggested by kicked user: "${kickedName}"`,
      );
      if (room.queue.length > 0) {
        const nextSong = room.queue.shift();
        room.currentSong = {
          ...nextSong,
          isPlaying: true,
          progress: 0,
          startTime: Date.now(),
        };
      } else {
        room.currentSong = null;
      }
      io.to(userRoomCode).emit("song:change", room.currentSong);
    }

    // Notify the kicked user
    io.to(kickSocketId).emit("user:kicked", { reason: "Removed by host" });

    // Force the kicked socket to leave the room channel
    const kickedSocket = io.sockets.sockets.get(kickSocketId);
    if (kickedSocket) {
      kickedSocket.leave(userRoomCode);
    }

    // Broadcast updated user list and queue
    io.to(userRoomCode).emit("room:user-update", room.users);
    io.to(room.hostSocketId).emit("queue:update", room.queue);

    if (typeof callback === "function") {
      callback({ success: true });
    }
  });

  // Extend room session activity
  socket.on("room:continue-activity", () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    logRoomEvent(
      room,
      `Room inactivity warning dismissed by user: "${userName || socket.id}"`,
    );
    resetRoomActivity(userRoomCode);
    io.to(userRoomCode).emit("room:inactivity-cancelled");
  });

  // Host ends room session
  socket.on("room:end", () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    logRoomEvent(room, "Room session ended by host.");

    clearRoomTimers(userRoomCode);

    io.to(userRoomCode).emit("room:ended");
    rooms.delete(userRoomCode);
  });

  // User leaves room manually
  socket.on("room:leave", () => {
    handleLeave();
  });

  // Connection lost
  socket.on("disconnect", () => {
    handleLeave();
  });

  function handleLeave() {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    if (room.hostSocketId === socket.id) {
      // Host disconnected: start grace period
      logRoomEvent(room, "Host disconnected. Starting 15s grace period.");

      // Notify guests that host is temporarily offline
      io.to(userRoomCode).emit("room:host-status", { connected: false });

      // Clear any existing timer
      if (roomDisconnectTimers.has(userRoomCode)) {
        clearTimeout(roomDisconnectTimers.get(userRoomCode));
      }

      const timer = setTimeout(() => {
        console.log(`Grace period expired. Closing room: ${userRoomCode}`);
        io.to(userRoomCode).emit("room:ended");

        clearRoomTimers(userRoomCode);
        rooms.delete(userRoomCode);
      }, 15000); // 15 seconds

      roomDisconnectTimers.set(userRoomCode, timer);
    } else {
      // Guest disconnected: remove user
      const leavingUser = room.users.find((u) => u && u.socketId === socket.id);
      const disconnectedName = leavingUser ? leavingUser.name : "Unknown Guest";
      room.users = room.users.filter((u) => u && u.socketId !== socket.id);
      logRoomEvent(room, `Guest left room: "${disconnectedName}"`);
      io.to(userRoomCode).emit("room:user-update", room.users);
      resetRoomActivity(userRoomCode);
    }

    userRoomCode = null;
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🎵 Local Party Music server running on port ${PORT}`);
  console.log(`🔗 Local WiFi IP to share: http://${LOCAL_IP}:${PORT}`);
  console.log(`======================================================\n`);
});
