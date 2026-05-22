/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Play, 
  Pause, 
  SkipForward, 
  Music, 
  Users, 
  Share2, 
  Plus, 
  Trash2, 
  Radio, 
  Sparkles, 
  Tv, 
  ArrowLeft, 
  Compass, 
  QrCode, 
  Power,
  Volume2,
  VolumeX,
  Layers,
  Settings,
  Wifi
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { SongSearchModal } from './components/SongSearchModal';
import { RoomQRModal } from './components/RoomQRModal';
import type { Song, PlayableSong } from './types';
import './App.css';

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

interface Toast {
  message: string;
  type: 'success' | 'info' | 'error';
}

interface RoomUser {
  socketId: string;
  name: string;
  isHost: boolean;
}

interface DiscoveredRoom {
  roomCode: string;
  roomName: string;
  hostName: string;
  userCount: number;
  currentSong: {
    title: string;
    artist: string;
    albumArt: string;
    isPlaying: boolean;
  } | null;
}

function App() {
  // App views
  const [currentView, setCurrentView] = useState<'landing' | 'create-room' | 'join-room' | 'player' | 'discovery'>('landing');
  const [userRole, setUserRole] = useState<'host' | 'guest' | null>(null);
  
  // Inputs
  const [hostName, setHostName] = useState(() => {
    return localStorage.getItem('party_host_name') || 'Host';
  });
  const [guestName, setGuestName] = useState(() => {
    return localStorage.getItem('party_guest_name') || 'Guest';
  });
  const [partyName, setPartyName] = useState('');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  
  // Active Room details
  const [roomCode, setRoomCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [hostLocalIp, setHostLocalIp] = useState('');
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [recentlyPlayed, setRecentlyPlayed] = useState<{ title: string; artist: string; albumArt: string }[]>([]);
  const [myUsername, setMyUsername] = useState('');
  
  // Music Playback state (synced)
  const [currentSong, setCurrentSong] = useState<PlayableSong | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Host-only: upcoming queue
  const [hostQueue, setHostQueue] = useState<PlayableSong[]>([]);
  
  // UI states
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isQrOpen, setIsQrOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoom[]>([]);
  const [isScanningQR, setIsScanningQR] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [backendHost, setBackendHost] = useState<string>(() => {
    const saved = localStorage.getItem('backend_host');
    const currentHost = window.location.hostname;
    const isCurrentLoopback = ['localhost', '127.0.0.1', '::1'].includes(currentHost);
    
    if (!isCurrentLoopback) {
      if (saved && !['localhost', '127.0.0.1', '::1'].includes(saved)) {
        return saved;
      }
      return currentHost;
    }
    return saved || currentHost;
  });
  const [isHostOnline, setIsHostOnline] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [ipInput, setIpInput] = useState(backendHost);
  
  // Sync ipInput with backendHost when it changes (e.g. on session restore)
  useEffect(() => {
    setIpInput(backendHost);
  }, [backendHost]);
  
  // Refs
  const socketRef = useRef<Socket | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const progressIntervalRef = useRef<number | null>(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const currentSongRef = useRef<PlayableSong | null>(null);

  // Handle Toast Notifications (using function declaration so it is hoisted and safe to use in hooks above)
  function showToast(message: string, type: 'success' | 'info' | 'error') {
    setToast({ message, type });
    setTimeout(() => {
      setToast(null);
    }, 3500);
  }

  // Parse room query parameter on initial load for QR Code Scan integration
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomCodeInput(roomParam.toUpperCase());
      setCurrentView('join-room');
      showToast(`Detected Room Code ${roomParam.toUpperCase()}!`, 'info');
    }
  }, []);

  // Initialize and load dependencies on mount (load YT script)
  useEffect(() => {
    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

      window.onYouTubeIframeAPIReady = () => {
        console.log("YouTube API ready.");
      };
    }
  }, []);

  // Auto-reconnect on mount if room session exists
  useEffect(() => {
    const sessionData = sessionStorage.getItem('room_session');
    if (!sessionData) return;

    try {
      const parsed = JSON.parse(sessionData);
      const { roomCode: savedRoomCode, role: savedRole, myUsername: savedUsername, backendHost: savedBackendHost } = parsed;
      
      if (savedRoomCode && savedRole && savedUsername) {
        console.log(`Attempting auto-reconnect for room: ${savedRoomCode}`);
        
        const currentHost = savedBackendHost || backendHost;
        if (savedBackendHost) {
          setBackendHost(savedBackendHost);
          localStorage.setItem('backend_host', savedBackendHost);
        }

        const socket = connectSocket(currentHost);

        socket.emit('room:reconnect', {
          roomCode: savedRoomCode,
          role: savedRole,
          username: savedUsername
        }, (res: any) => {
          if (res.success) {
            setUserRole(savedRole);
            setRoomCode(res.room.roomCode);
            setRoomName(res.room.roomName);
            setHostLocalIp(res.localIp);
            setMyUsername(res.username);
            setUsers(res.room.users);
            setCurrentSong(res.room.currentSong);
            setRecentlyPlayed(res.room.recentlyPlayed || []);
            
            if (savedRole === 'host') {
              setHostQueue(res.queue || []);
            }
            
            setCurrentView('player');
            showToast(`Restored session in room ${res.room.roomCode}!`, 'success');
          } else {
            console.log(`Reconnection failed: ${res.message}`);
            showToast(res.message || 'Active session could not be restored.', 'info');
            sessionStorage.removeItem('room_session');
            socket.disconnect();
            socketRef.current = null;
          }
        });
      }
    } catch (e) {
      console.error('Failed to parse active session storage:', e);
      sessionStorage.removeItem('room_session');
    }
  }, []);

  // Keep track of currentSong ref to avoid stale closures in interval / events
  useEffect(() => {
    currentSongRef.current = currentSong;
  }, [currentSong]);

  // YouTube Player Initialization
  useEffect(() => {
    if (userRole !== 'host' || currentView !== 'player') return;

    let player: any = null;


    const initPlayer = () => {
      const container = document.getElementById('youtube-player');
      if (!container) return false;
      if (!window.YT || !window.YT.Player) return false;

      console.log("Initializing YouTube Player on host...");
      player = new window.YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        videoId: currentSongRef.current?.url || '',
        playerVars: {
          autoplay: currentSongRef.current?.isPlaying ? 1 : 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          modestbranding: 1,
          rel: 0,
          showinfo: 0,
          iv_load_policy: 3,
          origin: window.location.origin
        },
        events: {
          onReady: (event: any) => {
            ytPlayerRef.current = event.target;
            setIsPlayerReady(true);
            
            if (isMuted) {
              event.target.mute();
            } else {
              event.target.unMute();
            }
          },
          onStateChange: (event: any) => {
            if (event.data === 0) { // ENDED
              console.log("YouTube track ended. Skipping.");
              if (socketRef.current) {
                socketRef.current.emit('song:skip');
              }
            }
          }
        }
      });
      return true;
    };

    const checkInterval = window.setInterval(() => {
      if (initPlayer()) {
        clearInterval(checkInterval);
      }
    }, 200);

    return () => {
      clearInterval(checkInterval);
      if (player && typeof player.destroy === 'function') {
        try {
          player.destroy();
        } catch (e) {
          console.warn("Error destroying player:", e);
        }
      }
      ytPlayerRef.current = null;
      setIsPlayerReady(false);
    };
  }, [userRole, currentView]);

  // Sync YouTube Player Playback for HOST
  useEffect(() => {
    if (userRole !== 'host' || !ytPlayerRef.current || !isPlayerReady) return;
    const player = ytPlayerRef.current;

    if (currentSong) {
      const videoId = currentSong.url;
      
      let currentVideoId = '';
      if (typeof player.getVideoData === 'function') {
        try {
          currentVideoId = player.getVideoData()?.video_id || '';
        } catch (e) {
          console.warn("Could not get video data:", e);
        }
      }

      if (!currentVideoId) {
        try {
          const url = player.getVideoUrl();
          const match = url?.match(/(?:v=|\/embed\/|v\/|youtu\.be\/|watch\?v=)([^#&?]*)/);
          currentVideoId = (match && match[1].length === 11) ? match[1] : '';
        } catch (e) {
          console.warn("Could not get video URL:", e);
        }
      }

      if (currentVideoId !== videoId) {
        console.log("Loading new video ID:", videoId);
        if (currentSong.isPlaying) {
          if (typeof player.loadVideoById === 'function') {
            player.loadVideoById({
              videoId: videoId,
              startSeconds: currentSong.progress || 0
            });
          }
          setIsPlaying(true);
        } else {
          if (typeof player.cueVideoById === 'function') {
            player.cueVideoById({
              videoId: videoId,
              startSeconds: currentSong.progress || 0
            });
          }
          setIsPlaying(false);
        }
      } else {
        let playerState = -1;
        if (typeof player.getPlayerState === 'function') {
          playerState = player.getPlayerState();
        }
        if (currentSong.isPlaying) {
          if (playerState !== 1 && typeof player.playVideo === 'function') {
            player.playVideo();
          }
          setIsPlaying(true);
        } else {
          if (playerState === 1 && typeof player.pauseVideo === 'function') {
            player.pauseVideo();
          }
          setIsPlaying(false);
        }
      }
    } else {
      if (typeof player.stopVideo === 'function') {
        try {
          player.stopVideo();
        } catch (e) {
          console.warn("Error stopping video:", e);
        }
      }
      setIsPlaying(false);
      setPlaybackProgress(0);
    }
  }, [currentSong, userRole, isPlayerReady]);

  // Sync mute state for HOST
  useEffect(() => {
    if (userRole !== 'host' || !ytPlayerRef.current || !isPlayerReady) return;
    if (isMuted) {
      ytPlayerRef.current.mute();
    } else {
      ytPlayerRef.current.unMute();
    }
  }, [isMuted, userRole, isPlayerReady]);

  // Host-only: Periodically emit playback progress updates to sync guests
  useEffect(() => {
    if (userRole !== 'host' || !isPlaying || !currentSong || !ytPlayerRef.current || !isPlayerReady) {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
      return;
    }

    progressIntervalRef.current = window.setInterval(() => {
      const player = ytPlayerRef.current;
      if (player && socketRef.current && typeof player.getCurrentTime === 'function') {
        const progress = player.getCurrentTime();
        setPlaybackProgress(progress);
        
        const playerState = player.getPlayerState();
        const isActuallyPlaying = playerState === 1;
        socketRef.current.emit('playback:progress-update', {
          progress,
          isPlaying: isActuallyPlaying
        });
      }
    }, 1000);

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, [userRole, isPlaying, currentSong, isPlayerReady]);

  // Connect to Socket.IO Server
  function connectSocket(targetHost: string = backendHost): Socket {
    if (socketRef.current) return socketRef.current;

    const serverUrl = `http://${targetHost}:3001`;
    console.log(`Connecting to Socket server: ${serverUrl}`);
    const socket = io(serverUrl);

    socket.on('connect_error', () => {
      showToast('Connection to server failed. Is server.js running?', 'error');
    });

    // Listeners for both Host & Guest
    socket.on('room:user-update', (updatedUsers: RoomUser[]) => {
      setUsers(updatedUsers);
    });

    socket.on('song:change', (newSong: PlayableSong | null) => {
      setCurrentSong(newSong);
      if (newSong) {
        setPlaybackProgress(newSong.progress || 0);
        setIsPlaying(newSong.isPlaying);
      } else {
        setPlaybackProgress(0);
        setIsPlaying(false);
      }
    });

    socket.on('playback:sync', ({ isPlaying: serverPlaying, progress }) => {
      setIsPlaying(serverPlaying);
      setCurrentSong(prev => prev ? { ...prev, isPlaying: serverPlaying } : null);
      
      if (userRole === 'host') {
        if (ytPlayerRef.current && isPlayerReady) {
          const player = ytPlayerRef.current;
          let playerState = -1;
          if (typeof player.getPlayerState === 'function') {
            playerState = player.getPlayerState();
          }
          if (serverPlaying && playerState !== 1 && typeof player.playVideo === 'function') {
            player.playVideo();
          } else if (!serverPlaying && playerState === 1 && typeof player.pauseVideo === 'function') {
            player.pauseVideo();
          }
        }
      } else {
        setPlaybackProgress(progress);
      }
    });

    socket.on('room:recently-played-update', (recent) => {
      setRecentlyPlayed(recent);
    });

    socket.on('room:ended', () => {
      showToast('The party session has been ended by the host.', 'info');
      disconnectSession();
    });

    socket.on('room:host-status', ({ connected }) => {
      setIsHostOnline(connected);
      if (connected) {
        showToast('Host is back online!', 'success');
      } else {
        showToast('Host is offline! Waiting for reconnect...', 'error');
      }
    });

    // Host-only Listeners
    socket.on('queue:update', (updatedQueue: PlayableSong[]) => {
      setHostQueue(updatedQueue);
    });

    socketRef.current = socket;
    return socket;
  }

  function disconnectSession() {
    // Clear audio/video players
    if (ytPlayerRef.current && typeof ytPlayerRef.current.stopVideo === 'function') {
      try {
        ytPlayerRef.current.stopVideo();
      } catch (e) {
        console.warn("Error stopping video in disconnect:", e);
      }
    }
    
    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.emit('room:leave');
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    // Reset States
    setRoomCode('');
    setRoomName('');
    setUserRole(null);
    setUsers([]);
    setCurrentSong(null);
    setPlaybackProgress(0);
    setIsPlaying(false);
    setHostQueue([]);
    setRecentlyPlayed([]);
    setIsHostOnline(true);
    sessionStorage.removeItem('room_session');
    setCurrentView('landing');
  }

  // Action: Create Room
  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyName.trim()) {
      showToast('Party Name is required.', 'error');
      return;
    }

    localStorage.setItem('party_host_name', hostName);

    const socket = connectSocket();

    socket.emit('room:create', { roomName: partyName, hostName }, (res: any) => {
      if (res.success) {
        setUserRole('host');
        setRoomCode(res.roomCode);
        setRoomName(partyName);
        setHostLocalIp(res.localIp);
        setMyUsername(hostName);
        setUsers(res.room.users);
        setCurrentView('player');

        sessionStorage.setItem('room_session', JSON.stringify({
          roomCode: res.roomCode,
          roomName: partyName,
          role: 'host',
          myUsername: hostName,
          backendHost: backendHost
        }));

        showToast('Room created successfully!', 'success');
      } else {
        showToast(res.message || 'Could not create room', 'error');
      }
    });
  };

  // Action: Join Room
  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCodeInput.trim() || !guestName.trim()) {
      showToast('Room code and Nickname are required.', 'error');
      return;
    }

    localStorage.setItem('party_guest_name', guestName);

    const socket = connectSocket();

    socket.emit('room:join', { roomCode: roomCodeInput, name: guestName }, (res: any) => {
      if (res.success) {
        setUserRole('guest');
        setRoomCode(res.room.roomCode);
        setRoomName(res.room.roomName);
        setHostLocalIp(res.localIp);
        setMyUsername(res.username);
        setUsers(res.room.users);
        setCurrentSong(res.room.currentSong);
        setRecentlyPlayed(res.room.recentlyPlayed || []);
        setCurrentView('player');

        sessionStorage.setItem('room_session', JSON.stringify({
          roomCode: res.room.roomCode,
          roomName: res.room.roomName,
          role: 'guest',
          myUsername: res.username,
          backendHost: backendHost
        }));

        showToast(`Joined party room!`, 'success');
      } else {
        showToast(res.message || 'Room not found. Check code.', 'error');
        socket.disconnect();
        socketRef.current = null;
      }
    });
  };

  // Action: Add song to queue (Shared modal callback)
  const handleAddSong = async (song: Song): Promise<boolean> => {
    return new Promise((resolve) => {
      if (!socketRef.current) {
        showToast('Socket not connected.', 'error');
        resolve(false);
        return;
      }

      socketRef.current.emit('song:add', { song }, (res: any) => {
        if (res.success) {
          showToast(`"${song.title}" suggested!`, 'success');
          resolve(true);
        } else {
          showToast('Failed to add song.', 'error');
          resolve(false);
        }
      });
    });
  };

  // Playback Control: Play / Pause
  const handlePlayPause = () => {
    if (!socketRef.current || !currentSong) return;
    
    const newPlayingState = !isPlaying;
    
    // If Host, play/pause locally first to handle browser user-gesture requirements
    if (userRole === 'host' && ytPlayerRef.current && isPlayerReady) {
      if (newPlayingState) {
        try {
          ytPlayerRef.current.playVideo();
        } catch (err) {
          console.warn("YouTube play blocked on toggle", err);
          showToast("Tap screen to interact and allow sound", "info");
        }
      } else {
        try {
          ytPlayerRef.current.pauseVideo();
        } catch (err) {
          console.warn("YouTube pause failed on toggle", err);
        }
      }
      setIsPlaying(newPlayingState);
      setCurrentSong(prev => prev ? { ...prev, isPlaying: newPlayingState } : null);
    }
    
    socketRef.current.emit('playback:state-change', { isPlaying: newPlayingState });
  };

  // Host Playback Control: Skip
  const handleSkip = () => {
    if (userRole !== 'host' || !socketRef.current) return;
    socketRef.current.emit('song:skip');
    showToast('Skipped song', 'info');
  };

  // Host Queue Control: Remove
  const handleRemoveFromQueue = (songId: string) => {
    if (userRole !== 'host' || !socketRef.current) return;
    socketRef.current.emit('song:remove-from-queue', { songId });
    showToast('Song removed from queue', 'info');
  };

  // Host Session Control: End Room
  const handleEndRoom = () => {
    if (userRole !== 'host' || !socketRef.current) return;
    if (confirm('Are you sure you want to end the party room session? This will disconnect all guests.')) {
      socketRef.current.emit('room:end');
      disconnectSession();
    }
  };

  // Discovery Action: Fetch Nearby Rooms
  const fetchNearbyRooms = async () => {
    try {
      const serverUrl = `http://${backendHost}:3001`;
      const res = await fetch(`${serverUrl}/api/rooms`);
      if (res.ok) {
        const data = await res.json();
        setDiscoveredRooms(data);
      } else {
        showToast('Could not fetch active rooms list.', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('Error discovering rooms. Is backend online?', 'error');
    }
  };

  useEffect(() => {
    if (currentView === 'discovery' || currentView === 'join-room') {
      fetchNearbyRooms();
      // Poll active rooms list every 5 seconds
      const interval = setInterval(fetchNearbyRooms, 5000);
      return () => clearInterval(interval);
    }
  }, [currentView, backendHost]);

  const selectDiscoveredRoom = (code: string) => {
    setRoomCodeInput(code);
    setCurrentView('join-room');
    showToast(`Pre-filled room code: ${code}`, 'success');
  };

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanIp = ipInput.trim();
    if (!cleanIp) {
      showToast('Server IP address is required.', 'error');
      return;
    }
    // Disconnect active socket if server IP changes so next connection uses the new IP
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setBackendHost(cleanIp);
    localStorage.setItem('backend_host', cleanIp);
    showToast(`Server Host IP set to: ${cleanIp}`, 'success');
    setShowSettings(false);
  };

  const handleSimulateQRScan = () => {
    setIsScanningQR(true);
    // Simulate camera activation delay, then auto-fill code if present in URL, or mock fill
    setTimeout(() => {
      setIsScanningQR(false);
      // Hardcode a mock scan code or pull from active list
      if (discoveredRooms.length > 0) {
        const mockCode = discoveredRooms[0].roomCode;
        setRoomCodeInput(mockCode);
        showToast(`QR Code Scanned Successfully! Room: ${mockCode}`, 'success');
      } else {
        setRoomCodeInput('PARTY');
        showToast('QR Code Scanned! (Mock Room: PARTY)', 'info');
      }
    }, 2500);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  return (
    <div className="min-h-screen bg-spotify-black text-white flex flex-col relative overflow-hidden">
      
      {/* Toast Notifications */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className={`fixed top-6 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-full shadow-2xl flex items-center gap-2 border text-sm font-semibold select-none ${
              toast.type === 'success' 
                ? 'bg-spotify-green/90 border-spotify-green text-black' 
                : toast.type === 'error'
                ? 'bg-red-500/90 border-red-500 text-white'
                : 'bg-spotify-gray border-white/10 text-white'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Grid Decorative Particles Backdrop */}
      <div className="absolute inset-0 pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-spotify-green/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-500/10 rounded-full blur-[120px]"></div>
        <div className="absolute inset-0 opacity-[0.02] bg-[linear-gradient(to_right,#808080_1px,transparent_1px),linear-gradient(to_bottom,#808080_1px,transparent_1px)] bg-[size:24px_24px]"></div>
      </div>

      {/* Main Layout */}
      <header className="w-full max-w-7xl mx-auto px-6 py-4 flex items-center justify-between z-10 border-b border-white/5 bg-spotify-black/30 backdrop-blur-md sticky top-0">
        <div 
          onClick={disconnectSession} 
          className="flex items-center gap-2 cursor-pointer group"
        >
          <div className="w-9 h-9 rounded-full bg-spotify-green flex items-center justify-center text-black font-extrabold group-hover:scale-105 transition-transform duration-300 shadow-[0_0_15px_rgba(29,185,84,0.3)]">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <span className="font-sans font-black text-xl tracking-tight bg-gradient-to-r from-white via-white to-spotify-green bg-clip-text text-transparent group-hover:text-glow transition duration-300">
            LocalParty
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs font-semibold">
          {roomCode && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
              <span className="w-2.5 h-2.5 rounded-full bg-spotify-green animate-ping"></span>
              <span className="text-spotify-text uppercase font-bold tracking-wide">Live Code:</span>
              <span className="text-white font-extrabold tracking-wider">{roomCode}</span>
            </div>
          )}

          {currentView !== 'landing' && !roomCode && (
            <button 
              onClick={() => setCurrentView('landing')} 
              className="flex items-center gap-1.5 text-spotify-text hover:text-white transition cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" /> Back to Home
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-8 flex flex-col justify-center items-center z-10 relative">
        <AnimatePresence mode="wait">
          
          {/* VIEW: LANDING PAGE */}
          {currentView === 'landing' && (
            <motion.div
              key="landing"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.4 }}
              className="w-full flex flex-col items-center py-12 text-center"
            >
              {/* Hero Label */}
              <div className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-spotify-green/10 border border-spotify-green/20 text-spotify-green text-xs font-extrabold mb-6 tracking-wide uppercase">
                <Sparkles className="w-3.5 h-3.5" />
                Next-Gen Surprise Playlist System
              </div>

              {/* Tagline */}
              <h1 className="text-5xl md:text-7xl font-extrabold font-sans tracking-tight leading-tight max-w-3xl mb-6">
                Music becomes more fun when the next song is a <span className="bg-gradient-to-r from-spotify-green to-emerald-400 bg-clip-text text-transparent text-glow">surprise</span>.
              </h1>
              
              <p className="text-spotify-text text-lg md:text-xl max-w-xl mb-10 font-medium leading-relaxed">
                Connect your party to a single local WiFi. Let guests add tracks, but keep the upcoming queue hidden. Experience pure playlist suspense!
              </p>

              {/* CTA Actions */}
              <div className="flex flex-col sm:flex-row gap-4 mb-16">
                <button
                  onClick={() => setCurrentView('create-room')}
                  className="px-8 py-4 rounded-full bg-spotify-green text-black font-extrabold hover:scale-105 hover:bg-spotify-green/95 active:scale-95 transition-all duration-300 shadow-[0_4px_30px_rgba(29,185,84,0.3)] flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Tv className="w-5 h-5" /> Host a Party Room
                </button>
                <button
                  onClick={() => setCurrentView('join-room')}
                  className="px-8 py-4 rounded-full bg-white/5 hover:bg-white/10 text-white font-extrabold hover:scale-105 active:scale-95 border border-white/10 hover:border-white/20 transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Users className="w-5 h-5 text-spotify-green" /> Join Existing Party
                </button>
                <button
                  onClick={() => setCurrentView('discovery')}
                  className="px-6 py-4 rounded-full text-spotify-text hover:text-white font-extrabold hover:scale-105 transition-all duration-300 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Compass className="w-5 h-5 text-spotify-green" /> Nearby Discovery
                </button>
              </div>

              {/* Server Host IP Configurator */}
              <div className="mb-12 w-full max-w-md mx-auto relative z-20">
                <button
                  type="button"
                  onClick={() => setShowSettings(!showSettings)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10 text-spotify-text hover:text-white transition text-xs font-bold cursor-pointer"
                >
                  <Settings className="w-4 h-4 text-spotify-green" />
                  <span>Server Connection: <strong className="text-spotify-green">{backendHost}</strong></span>
                </button>

                <AnimatePresence>
                  {showSettings && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden mt-4"
                    >
                      <form onSubmit={handleSaveSettings} className="glass-card p-5 rounded-2xl border border-white/10 flex flex-col gap-3 text-left">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-spotify-text flex items-center gap-2">
                          <Settings className="w-3.5 h-3.5" /> Server Host IP Config
                        </h4>
                        <p className="text-xxs text-spotify-text/80 leading-relaxed">
                          If you are joining from another computer or mobile device, enter the IP address of the Host PC here so you can connect.
                        </p>
                        <div className="flex gap-2 mt-1">
                          <input
                            type="text"
                            placeholder="e.g. 192.168.1.103 or localhost"
                            value={ipInput}
                            onChange={(e) => setIpInput(e.target.value)}
                            className="flex-1 px-3 py-2 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 text-xs font-semibold"
                          />
                          <button
                            type="submit"
                            className="px-4 py-2 bg-spotify-green text-black font-extrabold rounded-xl hover:scale-102 active:scale-98 text-xs cursor-pointer"
                          >
                            Save
                          </button>
                        </div>
                      </form>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Grid Features */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full">
                
                <div className="glass-card p-6 rounded-2xl text-left">
                  <div className="w-12 h-12 rounded-xl bg-spotify-green/10 text-spotify-green flex items-center justify-center mb-4">
                    <Radio className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">No latency playback</h3>
                  <p className="text-spotify-text text-sm leading-relaxed">
                    Audio plays exclusively on the host’s device. Avoid lag, phone echo, and Bluetooth latency over local network.
                  </p>
                </div>

                <div className="glass-card p-6 rounded-2xl text-left">
                  <div className="w-12 h-12 rounded-xl bg-spotify-green/10 text-spotify-green flex items-center justify-center mb-4">
                    <Layers className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">Hidden Shared Queue</h3>
                  <p className="text-spotify-text text-sm leading-relaxed">
                    Everyone suggests songs but only the host sees what is coming next. Guests enjoy the mystery of the next song selection.
                  </p>
                </div>

                <div className="glass-card p-6 rounded-2xl text-left">
                  <div className="w-12 h-12 rounded-xl bg-spotify-green/10 text-spotify-green flex items-center justify-center mb-4">
                    <Users className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">WiFi-based Discovery</h3>
                  <p className="text-spotify-text text-sm leading-relaxed">
                    Easily discover active rooms running on the same local network without registration or password prompts.
                  </p>
                </div>

              </div>
            </motion.div>
          )}

          {/* VIEW: CREATE ROOM PAGE */}
          {currentView === 'create-room' && (
            <motion.div
              key="create-room"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="w-full max-w-md glass-panel p-8 rounded-2xl shadow-2xl border border-white/5 z-10"
            >
              <div className="text-center mb-8">
                <h2 className="text-3xl font-extrabold">Host a New Party</h2>
                <p className="text-spotify-text text-sm mt-2">Set up your local network room instantly</p>
              </div>

              <form onSubmit={handleCreateRoom} className="space-y-6">
                <div>
                  <label htmlFor="party-name" className="block text-xs font-bold uppercase tracking-wider text-spotify-text mb-2">
                    Party Room Name
                  </label>
                  <input
                    id="party-name"
                    type="text"
                    required
                    placeholder="e.g. Jay's Chill Session"
                    value={partyName}
                    onChange={(e) => setPartyName(e.target.value)}
                    className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="host-name" className="block text-xs font-bold uppercase tracking-wider text-spotify-text mb-2">
                    Host Nickname
                  </label>
                  <input
                    id="host-name"
                    type="text"
                    required
                    placeholder="e.g. DJ Host"
                    value={hostName}
                    onChange={(e) => setHostName(e.target.value)}
                    className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-sm"
                  />
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    className="w-full py-3.5 rounded-xl bg-spotify-green text-black font-extrabold hover:scale-102 hover:bg-spotify-green/95 active:scale-98 transition cursor-pointer text-sm"
                  >
                    Launch Party Room
                  </button>
                </div>
              </form>

              <button
                onClick={() => setCurrentView('landing')}
                className="mt-6 w-full text-center text-xs font-semibold text-spotify-text hover:text-white transition flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" /> Cancel and Go Back
              </button>
            </motion.div>
          )}

          {/* VIEW: JOIN ROOM PAGE */}
          {currentView === 'join-room' && (
            <motion.div
              key="join-room"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="w-full max-w-md flex flex-col gap-6"
            >
              <div className="glass-panel p-8 rounded-2xl shadow-2xl border border-white/5 w-full">
                <div className="text-center mb-8">
                  <h2 className="text-3xl font-extrabold font-sans">Join the Party</h2>
                  <p className="text-spotify-text text-sm mt-2">Enter a room code or trigger QR Scan</p>
                </div>

                <form onSubmit={handleJoinRoom} className="space-y-5">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label htmlFor="room-code" className="block text-xs font-bold uppercase tracking-wider text-spotify-text mb-2">
                        Room Code
                      </label>
                      <input
                        id="room-code"
                        type="text"
                        required
                        maxLength={5}
                        placeholder="ABCDE"
                        value={roomCodeInput}
                        onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                        className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text font-mono font-extrabold tracking-widest text-center focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition uppercase text-sm"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={handleSimulateQRScan}
                        disabled={isScanningQR}
                        className="p-3.5 bg-white/5 border border-white/10 hover:bg-white/10 rounded-xl text-spotify-text hover:text-white transition flex items-center justify-center h-[50px] cursor-pointer"
                        title="Scan QR Code"
                      >
                        {isScanningQR ? (
                          <div className="w-5 h-5 rounded-full border-2 border-spotify-green border-t-transparent animate-spin" />
                        ) : (
                          <QrCode className="w-5 h-5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div>
                    <label htmlFor="guest-name" className="block text-xs font-bold uppercase tracking-wider text-spotify-text mb-2">
                      Your Nickname
                    </label>
                    <input
                      id="guest-name"
                      type="text"
                      required
                      placeholder="e.g. DJ Rock"
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                      className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-sm"
                    />
                  </div>

                  <div className="pt-2">
                    <button
                      type="submit"
                      className="w-full py-3.5 rounded-xl bg-spotify-green text-black font-extrabold hover:scale-102 hover:bg-spotify-green/95 active:scale-98 transition cursor-pointer text-sm"
                    >
                      Connect & Suggest Tracks
                    </button>
                  </div>
                </form>

                {/* Camera QR Simulation overlay */}
                <AnimatePresence>
                  {isScanningQR && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center p-6"
                    >
                      <div className="relative w-72 h-72 border-2 border-dashed border-white/40 rounded-3xl overflow-hidden flex items-center justify-center">
                        <div className="absolute inset-4 border border-spotify-green/50 rounded-2xl animate-pulse"></div>
                        {/* Scanner Laser beam */}
                        <div className="absolute top-0 inset-x-0 h-1 bg-spotify-green shadow-[0_0_15px_rgba(29,185,84,0.8)] animate-[bounce_2s_infinite]"></div>
                        <QrCode className="w-16 h-16 text-white/20" />
                        
                        <button
                          onClick={() => {
                            if (discoveredRooms.length > 0) {
                              setRoomCodeInput(discoveredRooms[0].roomCode);
                            }
                            setIsScanningQR(false);
                            showToast("Scanned simulated QR Code!", "success");
                          }}
                          className="absolute inset-0 bg-transparent flex items-center justify-center cursor-pointer"
                        >
                          <span className="bg-black/80 px-4 py-2 rounded-full text-xxs text-spotify-green uppercase tracking-widest font-extrabold shadow-lg">
                            Tap to Scan Code
                          </span>
                        </button>
                      </div>
                      <p className="mt-6 text-sm text-spotify-text">Position QR code inside the frame</p>
                      <button
                        onClick={() => setIsScanningQR(false)}
                        className="mt-6 px-5 py-2.5 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 text-xs font-bold transition cursor-pointer"
                      >
                        Cancel
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Inline settings in Join Room */}
                <div className="mt-6 pt-5 border-t border-white/5 w-full text-center">
                  <button
                    type="button"
                    onClick={() => setShowSettings(!showSettings)}
                    className="inline-flex items-center gap-2 text-xxs font-bold text-spotify-text hover:text-white transition cursor-pointer"
                  >
                    <Settings className="w-3.5 h-3.5 text-spotify-green" />
                    <span>Connection Settings: <strong className="text-spotify-green">{backendHost}</strong></span>
                  </button>

                  <AnimatePresence>
                    {showSettings && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden mt-3"
                      >
                        <form onSubmit={handleSaveSettings} className="p-4 bg-white/2 rounded-xl border border-white/5 flex flex-col gap-2 text-left">
                          <label className="text-xxs font-bold uppercase tracking-wider text-spotify-text flex items-center gap-1.5">
                            <Settings className="w-3 h-3" /> Server Host IP/Hostname
                          </label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="e.g. 192.168.1.103"
                              value={ipInput}
                              onChange={(e) => setIpInput(e.target.value)}
                              className="flex-1 px-3 py-1.5 bg-spotify-light-gray/60 border border-white/5 rounded-lg text-white focus:outline-hidden text-xs"
                            />
                            <button
                              type="submit"
                              className="px-3 py-1.5 bg-spotify-green text-black font-extrabold rounded-lg text-xs cursor-pointer"
                            >
                              Save
                            </button>
                          </div>
                        </form>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <button
                  onClick={() => setCurrentView('landing')}
                  className="mt-6 w-full text-center text-xs font-semibold text-spotify-text hover:text-white transition flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" /> Cancel and Go Back
                </button>
              </div>

              {/* Dynamic Nearby discovery list in join room page */}
              {discoveredRooms.length > 0 && (
                <div className="glass-panel p-6 rounded-2xl border border-white/5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-spotify-text mb-4">
                    Active Nearby Parties on WiFi
                  </h3>
                  <div className="space-y-3">
                    {discoveredRooms.map((r) => (
                      <div 
                        key={r.roomCode}
                        onClick={() => selectDiscoveredRoom(r.roomCode)}
                        className="flex items-center justify-between p-3 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-spotify-green/20 rounded-xl transition group cursor-pointer"
                      >
                        <div>
                          <h4 className="text-sm font-bold text-white group-hover:text-spotify-green transition">{r.roomName}</h4>
                          <p className="text-xs text-spotify-text mt-0.5">Host: {r.hostName} • {r.userCount} listening</p>
                        </div>
                        <span className="px-2.5 py-1 rounded bg-spotify-green/10 text-spotify-green text-xs font-extrabold font-mono uppercase tracking-wider">
                          {r.roomCode}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* VIEW: NEARBY ROOM DISCOVERY */}
          {currentView === 'discovery' && (
            <motion.div
              key="discovery"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="w-full max-w-xl glass-panel p-8 rounded-2xl shadow-2xl border border-white/5"
            >
              <div className="flex justify-between items-center mb-8">
                <div>
                  <h2 className="text-3xl font-extrabold">Discover Parties</h2>
                  <p className="text-spotify-text text-sm mt-1">Automatic discovery of local network sessions</p>
                </div>
                <button
                  onClick={fetchNearbyRooms}
                  className="p-2 rounded-full hover:bg-white/10 text-spotify-text hover:text-white transition cursor-pointer"
                  title="Refresh lists"
                >
                  <Compass className="w-5 h-5 text-spotify-green animate-spin" style={{ animationDuration: '6s' }} />
                </button>
              </div>

              {discoveredRooms.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-spotify-text">
                  <Radio className="w-12 h-12 mb-4 stroke-[1.5] text-spotify-text/30 animate-pulse" />
                  <p className="font-semibold text-white">Searching for active parties...</p>
                  <p className="text-xs max-w-xs mt-2">
                    Make sure an admin has created a room. Everyone must be connected to the same local WiFi.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {discoveredRooms.map((r) => (
                    <div 
                      key={r.roomCode}
                      className="p-4 bg-white/5 border border-white/5 rounded-xl flex items-center justify-between gap-4 hover:border-spotify-green/30 transition group"
                    >
                      <div className="min-w-0">
                        <h3 className="font-bold text-white group-hover:text-spotify-green transition truncate">{r.roomName}</h3>
                        <p className="text-xs text-spotify-text mt-1">
                          Host: <span className="font-semibold text-white">{r.hostName}</span> • {r.userCount} users connected
                        </p>
                        {r.currentSong && (
                          <div className="flex items-center gap-1.5 mt-2.5 text-xxs text-spotify-green">
                            <span className="w-1.5 h-1.5 rounded-full bg-spotify-green animate-ping"></span>
                            <span className="truncate">Playing: {r.currentSong.title}</span>
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => selectDiscoveredRoom(r.roomCode)}
                        className="px-4 py-2 rounded-full bg-spotify-green text-black font-extrabold hover:scale-105 active:scale-95 transition text-xs cursor-pointer"
                      >
                        Join Room
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                onClick={() => setCurrentView('landing')}
                className="mt-8 w-full text-center text-xs font-semibold text-spotify-text hover:text-white transition flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" /> Back to Home
              </button>
            </motion.div>
          )}

          {/* VIEW: MAIN PARTY ROOM PLAYER */}
          {currentView === 'player' && (
            <motion.div
              key="player"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="w-full grid grid-cols-1 lg:grid-cols-12 gap-8 items-start py-4"
            >
              {/* Host Offline Warning Banner */}
              {!isHostOnline && userRole === 'guest' && (
                <div className="lg:col-span-12 w-full bg-red-500/20 border border-red-500/30 text-red-200 px-6 py-4 rounded-2xl flex items-center justify-between gap-4 animate-pulse">
                  <div className="flex items-center gap-3">
                    <Wifi className="w-5 h-5 text-red-400" />
                    <div className="text-left">
                      <p className="text-sm font-bold">Host Disconnected</p>
                      <p className="text-xs text-red-300/80 mt-0.5">The host machine has lost connection. Playback is paused. Waiting for them to reconnect...</p>
                    </div>
                  </div>
                </div>
              )}
              {/* Left Column: Player Hub */}
              <div className="lg:col-span-7 flex flex-col items-center">
                
                {/* Room Info Header */}
                <div className="w-full flex items-center justify-between mb-8 px-2">
                  <div>
                    <h2 className="text-2xl font-extrabold leading-tight">{roomName}</h2>
                    <p className="text-xs text-spotify-text mt-1 flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-spotify-green animate-pulse"></span>
                      <span>Connected as <strong className="text-white font-bold">{myUsername}</strong> ({userRole})</span>
                    </p>
                  </div>
                  
                  <div className="flex gap-2">
                    <button
                      onClick={() => setIsQrOpen(true)}
                      className="p-2.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/5 text-spotify-text hover:text-white transition flex items-center gap-1.5 text-xs font-bold cursor-pointer"
                      title="Invite Friends"
                    >
                      <Share2 className="w-4 h-4" /> Invite
                    </button>
                    
                    {userRole === 'host' && (
                      <button
                        onClick={handleEndRoom}
                        className="p-2.5 rounded-full bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white border border-red-500/20 transition flex items-center gap-1.5 text-xs font-bold cursor-pointer"
                        title="End Session"
                      >
                        <Power className="w-4 h-4" /> End Party
                      </button>
                    )}

                    {userRole === 'guest' && (
                      <button
                        onClick={disconnectSession}
                        className="p-2.5 rounded-full bg-white/5 hover:bg-red-500/10 text-spotify-text hover:text-red-400 border border-white/5 hover:border-red-500/20 transition flex items-center gap-1.5 text-xs font-bold cursor-pointer"
                        title="Leave Party"
                      >
                        <Power className="w-4 h-4" /> Exit
                      </button>
                    )}
                  </div>
                </div>

                {/* Album Vinyl Player Card */}
                <div className="w-full max-w-sm glass-panel p-8 rounded-3xl flex flex-col items-center shadow-[0_15px_40px_rgba(0,0,0,0.6)] border border-white/5 relative mb-8">
                  {/* Decorative Speaker Grid Background */}
                  <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(#fff_1px,transparent_1px)] bg-[size:10px_10px] rounded-3xl pointer-events-none"></div>
                  
                  {/* Glowing dynamic background reflecting album state */}
                  <div className={`absolute w-64 h-64 rounded-full blur-[60px] opacity-25 top-12 transition-all duration-1000 pointer-events-none ${
                    isPlaying ? 'bg-spotify-green scale-110' : 'bg-transparent'
                  }`} />

                  {/* Widescreen Video Viewport for Host / Vinyl disc for Guest */}
                  {userRole === 'host' ? (
                    <div className="relative mb-8 w-full aspect-video flex items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black/60 shadow-2xl">
                      {/* YouTube player element must be present in the DOM always to avoid iframe recreation issues */}
                      <div 
                        id="youtube-player" 
                        className={`w-full h-full transition-opacity duration-300 ${currentSong ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} 
                      />
                      
                      {!currentSong && (
                        <div className="absolute inset-0 flex flex-col items-center justify-center text-spotify-text">
                          <Music className="w-12 h-12 mb-2 stroke-[1.5] text-spotify-text/30 animate-pulse" />
                          <p className="text-xs">No active video stream</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* Vinyl disc container for Guest */
                    <div className="relative mb-8 w-60 h-60 flex items-center justify-center select-none">
                      <AnimatePresence mode="wait">
                        {currentSong ? (
                          <motion.div
                            key={currentSong.id}
                            initial={{ scale: 0.95, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.95, opacity: 0 }}
                            className={`w-full h-full rounded-full border-[10px] border-spotify-gray shadow-[0_10px_35px_rgba(0,0,0,0.8)] relative overflow-hidden flex items-center justify-center p-4 bg-black ${
                              isPlaying ? 'animate-spin-slow' : ''
                            }`}
                          >
                            {/* Inner Vinyl Groove lines */}
                            <div className="absolute inset-3 border border-white/5 rounded-full"></div>
                            <div className="absolute inset-6 border border-white/5 rounded-full"></div>
                            <div className="absolute inset-10 border border-white/5 rounded-full"></div>
                            <div className="absolute inset-16 border border-white/5 rounded-full"></div>
                            
                            {/* Center Album Art label */}
                            <img
                              src={currentSong.albumArt}
                              alt={currentSong.title}
                              className="w-[110px] h-[110px] rounded-full object-cover border-4 border-spotify-dark/70"
                            />
                            {/* Center hole pin */}
                            <div className="absolute w-4 h-4 bg-spotify-black rounded-full border-2 border-spotify-gray shadow-inner"></div>
                          </motion.div>
                        ) : (
                          /* Empty state disk */
                          <div className="w-full h-full rounded-full border-8 border-dashed border-white/5 flex items-center justify-center p-8 bg-white/2 animate-pulse-slow">
                            <Music className="w-16 h-16 text-white/10" />
                          </div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* Track information */}
                  <div className="text-center w-full min-h-[70px] mb-8">
                    {currentSong ? (
                      <>
                        <h3 className="text-xl font-bold tracking-tight text-white line-clamp-1 select-all">{currentSong.title}</h3>
                        <p className="text-sm text-spotify-text mt-1.5 font-medium truncate">{currentSong.artist}</p>
                        <span className="inline-block mt-3 text-xxs font-extrabold uppercase tracking-widest text-spotify-green bg-spotify-green/10 border border-spotify-green/20 px-2.5 py-0.5 rounded-full">
                          Suggested by {currentSong.addedBy}
                        </span>
                      </>
                    ) : (
                      <>
                        <h3 className="text-lg font-bold text-spotify-text">No tracks active</h3>
                        <p className="text-xs text-spotify-text/60 mt-1 max-w-[220px] mx-auto leading-relaxed">
                          The party queue is empty. Click the button below to suggest a track!
                        </p>
                      </>
                    )}
                  </div>

                  {/* Dynamic Progress Bar */}
                  <div className="w-full space-y-2.5">
                    <div className="relative h-1 w-full bg-white/10 rounded-full overflow-hidden">
                      <div 
                        className="absolute left-0 top-0 h-full bg-spotify-green transition-all duration-300 shadow-[0_0_8px_#1db954]"
                        style={{ 
                          width: `${currentSong ? (playbackProgress / currentSong.duration) * 100 : 0}%` 
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-xxs font-bold text-spotify-text tracking-wide font-mono">
                      <span>{formatTime(playbackProgress)}</span>
                      <span>{formatTime(currentSong ? currentSong.duration : 0)}</span>
                    </div>
                  </div>

                  {/* Controller Playback Panel */}
                  <div className="w-full flex items-center justify-center gap-6 mt-8">
                    {/* Play/Pause Button for Everyone */}
                    <button
                      onClick={handlePlayPause}
                      disabled={!currentSong}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition shadow-lg cursor-pointer ${
                        currentSong 
                          ? 'bg-white text-black hover:scale-105 hover:bg-spotify-green hover:shadow-[0_0_20px_#1db954]' 
                          : 'bg-white/10 text-white/30 cursor-not-allowed'
                      }`}
                      title={currentSong ? (isPlaying ? 'Pause song' : 'Play song') : 'No song playing'}
                    >
                      {isPlaying ? <Pause className="w-6 h-6 fill-current stroke-[3]" /> : <Play className="w-6 h-6 fill-current stroke-[3] translate-x-0.5" />}
                    </button>

                    {userRole === 'host' ? (
                      <>
                        {/* Mute output button */}
                        <button
                          onClick={() => setIsMuted(!isMuted)}
                          className={`p-2.5 rounded-full transition border cursor-pointer ${
                            isMuted 
                              ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20' 
                              : 'bg-white/5 border-white/5 text-spotify-text hover:text-white hover:bg-white/10'
                          }`}
                          title={isMuted ? 'Unmute host device' : 'Mute host device'}
                        >
                          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                        </button>

                        <button
                          onClick={handleSkip}
                          disabled={!currentSong && hostQueue.length === 0}
                          className={`p-3 rounded-full border transition ${
                            (currentSong || hostQueue.length > 0)
                              ? 'bg-white/5 border-white/5 text-white hover:bg-white/10 hover:border-white/10 cursor-pointer'
                              : 'border-white/5 text-white/20 cursor-not-allowed'
                          }`}
                          title="Skip song"
                        >
                          <SkipForward className="w-5 h-5 fill-current" />
                        </button>
                      </>
                    ) : (
                      /* Guest View Suggest Track Action */
                      <button
                        onClick={() => setIsSearchOpen(true)}
                        className="px-6 py-3.5 rounded-full bg-spotify-green text-black font-extrabold flex items-center justify-center gap-2 hover:scale-105 active:scale-95 transition shadow-lg cursor-pointer text-sm"
                      >
                        <Plus className="w-4 h-4 stroke-[3]" /> Suggest a Song
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Active users & Host Queue Drawer OR Guest Recently Played */}
              <div className="lg:col-span-5 flex flex-col gap-6 w-full">
                
                {/* Online Users List Widget */}
                <div className="glass-panel p-6 rounded-2xl border border-white/5 w-full">
                  <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-3">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-spotify-text flex items-center gap-2">
                      <Users className="w-4 h-4 text-spotify-green" /> Party Members ({users.length})
                    </h3>
                  </div>
                  
                  <div className="flex flex-wrap gap-2 max-h-[140px] overflow-y-auto custom-scrollbar pr-1">
                    {users.map((u) => (
                      <span 
                        key={u.socketId}
                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
                          u.isHost
                            ? 'bg-spotify-green/10 border-spotify-green/30 text-spotify-green font-bold'
                            : 'bg-white/5 border-white/5 text-white'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${u.isHost ? 'bg-spotify-green animate-pulse' : 'bg-emerald-400'}`}></span>
                        {u.name} {u.isHost ? '(Host)' : ''}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Queue Display Box (Role Dependent) */}
                {userRole === 'host' ? (
                  /* HOST QUEUE - FULL DETAILS */
                  <div className="glass-panel p-6 rounded-2xl border border-white/5 flex-1 flex flex-col h-[400px]">
                    <div className="flex justify-between items-center mb-4 border-b border-white/5 pb-3">
                      <h3 className="text-sm font-bold uppercase tracking-wider text-spotify-text flex items-center gap-2">
                        <Layers className="w-4 h-4 text-spotify-green" /> Upcoming Shared Queue ({hostQueue.length})
                      </h3>
                      <button
                        onClick={() => setIsSearchOpen(true)}
                        className="px-2.5 py-1 rounded-full bg-white/5 border border-white/5 text-xxs font-bold text-white hover:bg-white/10 hover:border-white/10 transition flex items-center gap-1 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Track
                      </button>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-3">
                      {hostQueue.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full py-8 text-center text-spotify-text">
                          <Layers className="w-10 h-10 mb-3 stroke-[1.5] text-spotify-text/30" />
                          <p className="text-xs font-semibold">Queue is empty</p>
                          <p className="text-xxs mt-1">Guests can add songs anytime!</p>
                        </div>
                      ) : (
                        hostQueue.map((song) => (
                          <div 
                            key={song.id}
                            className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group"
                          >
                            <img 
                              src={song.albumArt} 
                              alt={song.album} 
                              className="w-10 h-10 rounded-md object-cover border border-white/5"
                            />
                            <div className="flex-1 min-w-0">
                              <h4 className="text-xs font-bold text-white truncate">{song.title}</h4>
                              <p className="text-xxs text-spotify-text truncate mt-0.5">
                                {song.artist} • By {song.addedBy}
                              </p>
                            </div>
                            <button
                              onClick={() => handleRemoveFromQueue(song.id)}
                              className="p-1.5 rounded-full hover:bg-red-500/10 text-spotify-text hover:text-red-400 transition opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
                              title="Remove from queue"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : (
                  /* GUEST VIEW - QUEUE IS COMPLETELY OBFUSCATED */
                  <div className="glass-panel p-6 rounded-2xl border border-white/5 flex-1 flex flex-col h-[400px]">
                    <div className="flex justify-between items-center mb-4 border-b border-white/5 pb-3">
                      <h3 className="text-sm font-bold uppercase tracking-wider text-spotify-text flex items-center gap-2">
                        <Layers className="w-4 h-4 text-spotify-green" /> Hidden Party Playlist
                      </h3>
                      <span className="text-xxs px-2 py-0.5 bg-spotify-green/10 text-spotify-green border border-spotify-green/20 rounded font-semibold tracking-wider animate-pulse uppercase">
                        Surprise Mode
                      </span>
                    </div>

                    {/* Fun obfuscated queue animation/text */}
                    <div className="flex-grow flex flex-col items-center justify-center p-6 text-center border border-dashed border-white/5 rounded-xl bg-white/2 mb-6">
                      <Sparkles className="w-10 h-10 text-spotify-green mb-3 animate-[bounce_3s_infinite]" />
                      <h4 className="text-xs font-bold text-white uppercase tracking-wider">The upcoming track list is hidden!</h4>
                      <p className="text-xxs text-spotify-text max-w-[240px] mt-2 leading-relaxed">
                        No spoilers here. Keep adding your favorite tracks and enjoy the suspense together!
                      </p>
                    </div>

                    {/* Recently Played tracks history */}
                    <div className="flex-1 flex flex-col min-h-[140px] overflow-hidden">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-spotify-text mb-3 border-b border-white/5 pb-2">
                        Recently Played
                      </h4>
                      <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2.5">
                        {recentlyPlayed.length === 0 ? (
                          <p className="text-xxs text-spotify-text/60 italic py-4">No tracks played yet.</p>
                        ) : (
                          recentlyPlayed.map((song, idx) => (
                            <div key={idx} className="flex items-center gap-2.5 p-1 rounded-lg">
                              <img 
                                src={song.albumArt} 
                                alt={song.title} 
                                className="w-8 h-8 rounded object-cover opacity-70 border border-white/5"
                              />
                              <div className="min-w-0">
                                <h5 className="text-xxs font-bold text-white truncate">{song.title}</h5>
                                <p className="text-xxxs text-spotify-text truncate mt-0.5">{song.artist}</p>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                )}
                
              </div>

            </motion.div>
          )}

        </AnimatePresence>
      </main>

      {/* Global Bottom sticky banner for music discovery when not in player */}
      {currentView === 'landing' && discoveredRooms.length > 0 && (
        <div className="w-full bg-spotify-green/95 text-black py-2.5 px-6 font-semibold text-center text-xs flex justify-center items-center gap-3 z-20 cursor-pointer hover:bg-spotify-green transition-all"
             onClick={() => setCurrentView('discovery')}>
          <Compass className="w-4 h-4 animate-spin" style={{ animationDuration: '8s' }} />
          <span>{discoveredRooms.length} active party room{discoveredRooms.length > 1 ? 's' : ''} detected on your WiFi network! Tap to discover.</span>
        </div>
      )}

      {/* Footer */}
      <footer className="w-full border-t border-white/5 bg-spotify-black/20 py-4 text-center text-xxs text-spotify-text font-bold uppercase tracking-wider z-10">
        LocalParty © {new Date().getFullYear()} • Dedicated Local Network Surprise Playlist System
      </footer>

      {/* MODALS */}
      <SongSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        onAddSong={handleAddSong}
        backendHost={backendHost}
      />

      <RoomQRModal
        isOpen={isQrOpen}
        onClose={() => setIsQrOpen(false)}
        roomCode={roomCode}
        localIp={hostLocalIp}
      />

    </div>
  );
}

export default App;
