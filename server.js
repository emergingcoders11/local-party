import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import os from 'os';
import yts from 'yt-search';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// In-memory data store
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

  console.log(`Room ${roomCode} has been inactive for 1 hour. Broadcasting warning.`);
  io.to(roomCode).emit('room:inactivity-warning', {
    warningTimeoutMs: WARNING_TIMEOUT_MS
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

  // Clear timers
  const inactiveTimer = inactivityTimers.get(roomCode);
  if (inactiveTimer) clearTimeout(inactiveTimer);
  inactivityTimers.delete(roomCode);

  const warningTimer = warningTimers.get(roomCode);
  if (warningTimer) clearTimeout(warningTimer);
  warningTimers.delete(roomCode);

  // Clear host disconnect grace period timer
  if (roomDisconnectTimers.has(roomCode)) {
    clearTimeout(roomDisconnectTimers.get(roomCode));
    roomDisconnectTimers.delete(roomCode);
  }

  io.to(roomCode).emit('room:destroyed-inactivity');
  rooms.delete(roomCode);
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
        startTime: Date.now()
      };
      io.to(roomCode).emit('song:change', room.currentSong);
      io.to(room.hostSocketId).emit('queue:update', room.queue);
      return;
    }

    if (!previousSong) {
      room.currentSong = null;
      io.to(roomCode).emit('song:change', null);
      return;
    }

    // Search YouTube for related songs
    const query = `${previousSong.title} ${previousSong.artist || ''} related music`;
    console.log(`[Autoplay] Queue empty in room ${roomCode}. Searching related songs for: "${query}"`);

    const r = await yts(query);
    const videos = r.videos || [];

    // Filter out the exact same video ID
    const nextVideo = videos.find(v => v.videoId !== previousSong.id && v.videoId !== previousSong.url);

    if (nextVideo) {
      const autoplaySong = {
        id: nextVideo.videoId,
        title: nextVideo.title,
        artist: (nextVideo.author && nextVideo.author.name) || 'Autoplay Artist',
        album: 'Autoplay Related',
        duration: nextVideo.seconds || 180,
        albumArt: nextVideo.thumbnail || nextVideo.image || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80',
        url: nextVideo.videoId,
        addedBy: 'Autoplay',
        addedAt: Date.now()
      };

      room.currentSong = {
        ...autoplaySong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now()
      };

      console.log(`[Autoplay] Playing related song: "${autoplaySong.title}" in room ${roomCode}`);
      io.to(roomCode).emit('song:change', room.currentSong);
    } else {
      console.log(`[Autoplay] No related songs found for room ${roomCode}`);
      room.currentSong = null;
      io.to(roomCode).emit('song:change', null);
    }
  } catch (err) {
    console.error(`[Autoplay] Error finding related song for room ${roomCode}:`, err);
    room.currentSong = null;
    io.to(roomCode).emit('song:change', null);
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
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIpAddress();

// Expose discovery API
app.get('/api/rooms', (req, res) => {
  const isLocalOnly = req.query.local === 'true';
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

  let roomList = Array.from(rooms.values());

  if (isLocalOnly) {
    roomList = roomList.filter(room => {
      // Find host user's IP
      const hostUser = room.users.find(u => u.isHost);
      const hostIp = hostUser ? hostUser.ip : null;

      if (!hostIp) return false;

      // If client is loopback, match loopback IPs
      const isClientLoopback = clientIp === '::1' || clientIp === '127.0.0.1' || clientIp.includes('::ffff:127.0.0.1');
      const isHostLoopback = hostIp === '::1' || hostIp === '127.0.0.1' || hostIp.includes('::ffff:127.0.0.1');
      if (isClientLoopback && isHostLoopback) {
        return true;
      }

      // Otherwise, match exact external IPs (which are identical for users sharing NAT/Wi-Fi router)
      const normClientIp = clientIp.replace(/^::ffff:/, '');
      const normHostIp = hostIp.replace(/^::ffff:/, '');
      return normClientIp === normHostIp;
    });
  }

  const activeRooms = roomList.map(room => ({
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostName: room.hostName,
    userCount: room.users.length,
    isPrivate: !!room.password,
    currentSong: room.currentSong ? {
      title: room.currentSong.title,
      artist: room.currentSong.artist,
      albumArt: room.currentSong.albumArt,
      isPlaying: room.currentSong.isPlaying
    } : null
  }));
  res.json(activeRooms);
});



// Expose local network info API
app.get('/api/network', (req, res) => {
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
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]*).*/;
  const match = trimmed.match(regExp);
  if (match && match[2].length === 11) {
    return match[2];
  }
  return null;
}

// Expose YouTube search API
app.get('/api/search', async (req, res) => {
  const rawQuery = req.query.q || '';
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
          artist: (video.author && video.author.name) || 'Unknown Artist',
          album: 'YouTube Video',
          duration: video.seconds || 180,
          albumArt: video.thumbnail || video.image || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80',
          url: video.videoId
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
    if (!lowerQuery.includes('music') && !lowerQuery.includes('song') && !lowerQuery.includes('video') && !lowerQuery.includes('official')) {
      searchQuery = `${trimmedQuery} music`;
    }

    console.log(`Searching YouTube for: "${searchQuery}" (original: "${trimmedQuery}")`);
    const r = await yts(searchQuery);
    // Limit to 10 results for faster response and clean UI
    const videos = (r.videos || []).slice(0, 10);
    const results = videos.map(v => ({
      id: v.videoId,
      title: v.title,
      artist: (v.author && v.author.name) || 'Unknown Artist',
      album: 'YouTube Video',
      duration: v.seconds || 180,
      albumArt: v.thumbnail || v.image || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80',
      url: v.videoId
    }));

    searchCache.set(cacheKey, { timestamp: now, results });
    res.json(results);
  } catch (error) {
    console.error('YouTube search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});


// System name endpoint removed

// Socket.IO logic
io.on('connection', (socket) => {
  let userRoomCode = null;
  let userName = null;

  // Create Room
  socket.on('room:create', ({ roomName, hostName, password }, callback) => {
    // Generate simple 5-digit room code
    let roomCode;
    do {
      roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
    } while (rooms.has(roomCode));

    const room = {
      roomCode,
      roomName,
      hostSocketId: socket.id,
      hostName,
      users: [{ socketId: socket.id, name: hostName, isHost: true, ip: socket.handshake.address }],
      currentSong: null,
      queue: [],
      password: password || null,
      lastActivityTime: Date.now()
    };

    rooms.set(roomCode, room);
    userRoomCode = roomCode;
    userName = hostName;
    socket.join(roomCode);
    resetRoomActivity(roomCode);

    console.log(`Room created: ${roomCode} by ${hostName} ("${roomName}")`);
    if (typeof callback === 'function') {
      callback({ success: true, roomCode, room, localIp: LOCAL_IP });
    }
  });

  // Join Room
  socket.on('room:join', ({ roomCode, name, password }, callback) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room not found' });
      }
      return;
    }

    // Validate password for private rooms
    if (room.password && room.password !== password) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Incorrect room password.' });
      }
      return;
    }

    const joinNameRaw = name?.trim() || '';
    if (!joinNameRaw || joinNameRaw.toLowerCase() === 'guest') {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'A valid name is required to join. "Guest" is not allowed.' });
      }
      return;
    }

    const joinName = joinNameRaw;

    // Check if user already in room
    const userExists = room.users.some(u => u && u.name && u.name.toLowerCase() === joinName.toLowerCase());
    const finalName = userExists ? `${joinName} #${room.users.length + 1}` : joinName;

    const newUser = { socketId: socket.id, name: finalName, isHost: false, ip: socket.handshake.address };
    room.users.push(newUser);
    userRoomCode = code;
    userName = finalName;
    socket.join(code);

    console.log(`User ${finalName} joined room: ${code}`);

    // Notify other users
    io.to(code).emit('room:user-update', room.users);
    resetRoomActivity(code);

    // Send success feedback with sanitised room view (no upcoming queue details for guests)
    const clientRoomState = {
      roomCode: room.roomCode,
      roomName: room.roomName,
      hostName: room.hostName,
      users: room.users,
      currentSong: room.currentSong
    };

    if (typeof callback === 'function') {
      callback({ success: true, room: clientRoomState, username: finalName, localIp: LOCAL_IP });
    }
  });

  // Reconnect to active session
  socket.on('room:reconnect', ({ roomCode, role, username }, callback) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Session expired or room not found' });
      }
      return;
    }

    console.log(`Reconnection request: ${username} (${role}) for room: ${code}`);

    // If host is reconnecting, cancel the grace period timer
    if (role === 'host') {
      const timer = roomDisconnectTimers.get(code);
      if (timer) {
        clearTimeout(timer);
        roomDisconnectTimers.delete(code);
        console.log(`Host reconnected. Grace period cancelled for room: ${code}`);
      }

      room.hostSocketId = socket.id;
      
      // Update or add host in the users list
      const hostUser = room.users.find(u => u.isHost);
      if (hostUser) {
        hostUser.socketId = socket.id;
        hostUser.name = username || room.hostName;
      } else {
        room.users.push({ socketId: socket.id, name: username || room.hostName, isHost: true, ip: socket.handshake.address });
      }

      // Notify guests that the host is back online
      io.to(code).emit('room:host-status', { connected: true });
    } else {
      // Guest is reconnecting
      // Update their socket ID in the users list
      const guestUser = room.users.find(u => u.name === username);
      if (guestUser) {
        guestUser.socketId = socket.id;
      } else {
        room.users.push({ socketId: socket.id, name: username, isHost: false, ip: socket.handshake.address });
      }
    }

    userRoomCode = code;
    userName = username || (role === 'host' ? room.hostName : 'Guest');
    socket.join(code);

    // Broadcast updated users list
    io.to(code).emit('room:user-update', room.users);
    resetRoomActivity(code);

    const clientRoomState = {
      roomCode: room.roomCode,
      roomName: room.roomName,
      hostName: room.hostName,
      users: room.users,
      currentSong: room.currentSong
    };

    if (typeof callback === 'function') {
      callback({
        success: true,
        room: clientRoomState,
        username: userName,
        localIp: LOCAL_IP,
        queue: role === 'host' ? room.queue : []
      });
    }
  });

  // Add Song
  socket.on('song:add', ({ song }, callback) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    const newSong = {
      ...song,
      id: Math.random().toString(36).substring(2, 9),
      addedBy: userName || 'Guest',
      addedAt: Date.now()
    };

    if (!room.currentSong) {
      // If nothing is playing, play immediately
      room.currentSong = {
        ...newSong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now()
      };
      
      // Notify all users in the room of the new playing song
      io.to(userRoomCode).emit('song:change', room.currentSong);
      console.log(`Room ${userRoomCode}: Playing first suggested song "${newSong.title}"`);
    } else {
      // Otherwise put it in the queue
      room.queue.push(newSong);
      console.log(`Room ${userRoomCode}: Added "${newSong.title}" to queue. Queue size is now ${room.queue.length}`);
    }

    resetRoomActivity(userRoomCode);

    // Notify host of full queue updates
    io.to(room.hostSocketId).emit('queue:update', room.queue);

    // Send success notification to client
    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  // Play/Pause Song (Anyone)
  socket.on('playback:state-change', ({ isPlaying }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    resetRoomActivity(userRoomCode);

    if (room.currentSong) {
      room.currentSong.isPlaying = isPlaying;
      // Broadcast update to everyone
      io.to(userRoomCode).emit('playback:sync', {
        isPlaying,
        progress: room.currentSong.progress,
        songId: room.currentSong.id
      });
    }
  });

  // Progress Seek (Anyone)
  socket.on('playback:seek', ({ progress }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || !room.currentSong) return;

    resetRoomActivity(userRoomCode);

    room.currentSong.progress = progress;
    // Broadcast seek event to everyone in the room
    io.to(userRoomCode).emit('playback:seek', {
      progress,
      isPlaying: room.currentSong.isPlaying,
      songId: room.currentSong.id
    });
  });

  // Progress Update (Periodically sent by Host)
  socket.on('playback:progress-update', ({ progress, isPlaying }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.currentSong) {
      room.currentSong.progress = progress;
      room.currentSong.isPlaying = isPlaying;
      
      // Broadcast progress syncing to guests
      socket.to(userRoomCode).emit('playback:sync', {
        isPlaying,
        progress,
        songId: room.currentSong.id
      });
    }
  });

  // Host skips song (or song ends and auto-skips)
  socket.on('song:skip', () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    const previousSong = room.currentSong;

    if (room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentSong = {
        ...nextSong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now()
      };
      console.log(`Room ${userRoomCode}: Skipping to next song "${nextSong.title}"`);
      // Broadcast new state
      io.to(userRoomCode).emit('song:change', room.currentSong);
      // Send updated queue to host
      io.to(room.hostSocketId).emit('queue:update', room.queue);
    } else {
      console.log(`Room ${userRoomCode}: Queue empty, starting autoplay...`);
      playRelatedSong(userRoomCode, previousSong);
    }
  });

  // Host removes song from queue
  socket.on('song:remove-from-queue', ({ songId }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    resetRoomActivity(userRoomCode);

    room.queue = room.queue.filter(song => song.id !== songId);
    console.log(`Room ${userRoomCode}: Removed song ${songId} from queue.`);
    
    // Update queue list on Host
    io.to(room.hostSocketId).emit('queue:update', room.queue);
  });

  // Host kicks a user from the room
  socket.on('user:kick', ({ socketId: kickSocketId }, callback) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    resetRoomActivity(userRoomCode);

    const kickedUser = room.users.find(u => u.socketId === kickSocketId);
    if (!kickedUser || kickedUser.isHost) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Cannot kick this user.' });
      }
      return;
    }

    const kickedName = kickedUser.name;
    console.log(`Host kicked user: ${kickedName} from room ${userRoomCode}`);

    // Remove user from the room's users list
    room.users = room.users.filter(u => u.socketId !== kickSocketId);

    // Remove all songs added by the kicked user from the queue
    const prevQueueLength = room.queue.length;
    room.queue = room.queue.filter(song => song.addedBy !== kickedName);
    if (room.queue.length !== prevQueueLength) {
      console.log(`Removed ${prevQueueLength - room.queue.length} songs from queue added by ${kickedName}`);
    }

    // If the currently playing song was added by the kicked user, skip it
    if (room.currentSong && room.currentSong.addedBy === kickedName) {
      console.log(`Skipping current song added by kicked user: ${kickedName}`);
      if (room.queue.length > 0) {
        const nextSong = room.queue.shift();
        room.currentSong = {
          ...nextSong,
          isPlaying: true,
          progress: 0,
          startTime: Date.now()
        };
      } else {
        room.currentSong = null;
      }
      io.to(userRoomCode).emit('song:change', room.currentSong);
    }

    // Notify the kicked user
    io.to(kickSocketId).emit('user:kicked', { reason: 'Removed by host' });

    // Force the kicked socket to leave the room channel
    const kickedSocket = io.sockets.sockets.get(kickSocketId);
    if (kickedSocket) {
      kickedSocket.leave(userRoomCode);
    }

    // Broadcast updated user list and queue
    io.to(userRoomCode).emit('room:user-update', room.users);
    io.to(room.hostSocketId).emit('queue:update', room.queue);

    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  // Extend room session activity
  socket.on('room:continue-activity', () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    console.log(`Activity continued in room ${userRoomCode} by user ${userName || socket.id}`);
    resetRoomActivity(userRoomCode);
    io.to(userRoomCode).emit('room:inactivity-cancelled');
  });

  // Host ends room session
  socket.on('room:end', () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    console.log(`Room ended: ${userRoomCode}`);

    // Clear inactivity timers
    if (room.inactivityTimeout) clearTimeout(room.inactivityTimeout);
    if (room.warningTimeout) clearTimeout(room.warningTimeout);
    
    // Clear any active disconnect timer for this room
    if (roomDisconnectTimers.has(userRoomCode)) {
      clearTimeout(roomDisconnectTimers.get(userRoomCode));
      roomDisconnectTimers.delete(userRoomCode);
    }

    io.to(userRoomCode).emit('room:ended');
    rooms.delete(userRoomCode);
  });

  // User leaves room manually
  socket.on('room:leave', () => {
    handleLeave();
  });

  // Connection lost
  socket.on('disconnect', () => {
    handleLeave();
  });

  function handleLeave() {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    if (room.hostSocketId === socket.id) {
      // Host disconnected: start grace period
      console.log(`Host disconnected. Starting 15s grace period for room: ${userRoomCode}`);
      
      // Notify guests that host is temporarily offline
      io.to(userRoomCode).emit('room:host-status', { connected: false });

      // Clear any existing timer
      if (roomDisconnectTimers.has(userRoomCode)) {
        clearTimeout(roomDisconnectTimers.get(userRoomCode));
      }

      const timer = setTimeout(() => {
        console.log(`Grace period expired. Closing room: ${userRoomCode}`);
        io.to(userRoomCode).emit('room:ended');
        
        // Clear inactivity timers
        const r = rooms.get(userRoomCode);
        if (r) {
          if (r.inactivityTimeout) clearTimeout(r.inactivityTimeout);
          if (r.warningTimeout) clearTimeout(r.warningTimeout);
        }

        rooms.delete(userRoomCode);
        roomDisconnectTimers.delete(userRoomCode);
      }, 15000); // 15 seconds

      roomDisconnectTimers.set(userRoomCode, timer);
    } else {
      // Guest disconnected: remove user
      room.users = room.users.filter(u => u && u.socketId !== socket.id);
      console.log(`User left room ${userRoomCode}: socket ${socket.id}`);
      io.to(userRoomCode).emit('room:user-update', room.users);
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
