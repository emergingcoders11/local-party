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
  const activeRooms = Array.from(rooms.values()).map(room => ({
    roomCode: room.roomCode,
    roomName: room.roomName,
    hostName: room.hostName,
    userCount: room.users.length,
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

// Expose YouTube search API
app.get('/api/search', async (req, res) => {
  const query = req.query.q || 'trending music videos';
  try {
    const r = await yts(query);
    const videos = (r.videos || []).slice(0, 25);
    const results = videos.map(v => ({
      id: v.videoId,
      title: v.title,
      artist: v.author.name || 'Unknown Channel',
      album: 'YouTube Video',
      duration: v.seconds || 180,
      albumArt: v.thumbnail || v.image || 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80',
      url: v.videoId // We store videoId as the playback URL reference
    }));
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
  socket.on('room:create', ({ roomName, hostName }, callback) => {
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
      users: [{ socketId: socket.id, name: hostName, isHost: true }],
      currentSong: null,
      queue: [],
      recentlyPlayed: []
    };

    rooms.set(roomCode, room);
    userRoomCode = roomCode;
    userName = hostName;
    socket.join(roomCode);

    console.log(`Room created: ${roomCode} by ${hostName} ("${roomName}")`);
    if (typeof callback === 'function') {
      callback({ success: true, roomCode, room, localIp: LOCAL_IP });
    }
  });

  // Join Room
  socket.on('room:join', ({ roomCode, name }, callback) => {
    const code = roomCode?.toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      if (typeof callback === 'function') {
        callback({ success: false, message: 'Room not found' });
      }
      return;
    }

    const joinName = name?.trim() || 'Guest';

    // Check if user already in room
    const userExists = room.users.some(u => u && u.name && u.name.toLowerCase() === joinName.toLowerCase());
    const finalName = userExists ? `${joinName} #${room.users.length + 1}` : joinName;

    const newUser = { socketId: socket.id, name: finalName, isHost: false };
    room.users.push(newUser);
    userRoomCode = code;
    userName = finalName;
    socket.join(code);

    console.log(`User ${finalName} joined room: ${code}`);

    // Notify other users
    io.to(code).emit('room:user-update', room.users);

    // Send success feedback with sanitised room view (no upcoming queue details for guests)
    const clientRoomState = {
      roomCode: room.roomCode,
      roomName: room.roomName,
      hostName: room.hostName,
      users: room.users,
      currentSong: room.currentSong,
      recentlyPlayed: room.recentlyPlayed
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
        room.users.push({ socketId: socket.id, name: username || room.hostName, isHost: true });
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
        room.users.push({ socketId: socket.id, name: username, isHost: false });
      }
    }

    userRoomCode = code;
    userName = username || (role === 'host' ? room.hostName : 'Guest');
    socket.join(code);

    // Broadcast updated users list
    io.to(code).emit('room:user-update', room.users);

    const clientRoomState = {
      roomCode: room.roomCode,
      roomName: room.roomName,
      hostName: room.hostName,
      users: room.users,
      currentSong: room.currentSong,
      recentlyPlayed: room.recentlyPlayed
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
    if (previousSong) {
      // Add to recently played (keep max 8)
      room.recentlyPlayed = [
        { title: previousSong.title, artist: previousSong.artist, albumArt: previousSong.albumArt },
        ...room.recentlyPlayed
      ].slice(0, 8);
      io.to(userRoomCode).emit('room:recently-played-update', room.recentlyPlayed);
    }

    if (room.queue.length > 0) {
      const nextSong = room.queue.shift();
      room.currentSong = {
        ...nextSong,
        isPlaying: true,
        progress: 0,
        startTime: Date.now()
      };
      console.log(`Room ${userRoomCode}: Skipping to next song "${nextSong.title}"`);
    } else {
      room.currentSong = null;
      console.log(`Room ${userRoomCode}: Queue empty, stopping playback.`);
    }

    // Broadcast new state
    io.to(userRoomCode).emit('song:change', room.currentSong);
    // Send updated queue to host
    io.to(room.hostSocketId).emit('queue:update', room.queue);
  });

  // Host removes song from queue
  socket.on('song:remove-from-queue', ({ songId }) => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    room.queue = room.queue.filter(song => song.id !== songId);
    console.log(`Room ${userRoomCode}: Removed song ${songId} from queue.`);
    
    // Update queue list on Host
    io.to(room.hostSocketId).emit('queue:update', room.queue);
  });

  // Host ends room session
  socket.on('room:end', () => {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room || room.hostSocketId !== socket.id) return;

    console.log(`Room ended: ${userRoomCode}`);
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
        rooms.delete(userRoomCode);
        roomDisconnectTimers.delete(userRoomCode);
      }, 15000); // 15 seconds

      roomDisconnectTimers.set(userRoomCode, timer);
    } else {
      // Guest disconnected: remove user
      room.users = room.users.filter(u => u && u.socketId !== socket.id);
      console.log(`User left room ${userRoomCode}: socket ${socket.id}`);
      io.to(userRoomCode).emit('room:user-update', room.users);
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
