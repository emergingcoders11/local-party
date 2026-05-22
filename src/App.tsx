/* eslint-disable react-hooks/set-state-in-effect */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, memo } from 'react';
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
  Wifi,
  Lock,
  X,
  Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { SongSearchModal } from './components/SongSearchModal';
import { RoomQRModal } from './components/RoomQRModal';
import { ConfirmationModal } from './components/ConfirmationModal';
import { InactivityWarningModal } from './components/InactivityWarningModal';
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
  ip?: string;
}

interface DiscoveredRoom {
  roomCode: string;
  roomName: string;
  hostName: string;
  userCount: number;
  isPrivate: boolean;
  currentSong: {
    title: string;
    artist: string;
    albumArt: string;
    isPlaying: boolean;
  } | null;
}

const YouTubePlaceholder = memo(() => {
  return <div id="youtube-player" className="w-full h-full" />;
}, () => true);

function App() {
  // App views
  const [currentView, setCurrentView] = useState<'landing' | 'create-room' | 'join-room' | 'player' | 'discovery'>('landing');
  const [userRole, setUserRole] = useState<'host' | 'guest' | null>(null);
  
  // Inputs
  const [hostName, setHostName] = useState('');
  const [guestName, setGuestName] = useState('');
  const [partyName, setPartyName] = useState('');
  const [roomCodeInput, setRoomCodeInput] = useState('');
  
  // Room password
  const [roomPassword, setRoomPassword] = useState('');
  const [isPrivateRoom, setIsPrivateRoom] = useState(false);
  const [joinPassword, setJoinPassword] = useState('');
  
  // Active Room details
  const [roomCode, setRoomCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [hostLocalIp, setHostLocalIp] = useState('');
  const [users, setUsers] = useState<RoomUser[]>([]);
  const [myUsername, setMyUsername] = useState('');
  
  // Room search + kick
  const [roomSearchQuery, setRoomSearchQuery] = useState('');
  const [kickTarget, setKickTarget] = useState<RoomUser | null>(null);
  const [isConfirmKickOpen, setIsConfirmKickOpen] = useState(false);
  
  // Music Playback state (synced)
  const [currentSong, setCurrentSong] = useState<PlayableSong | null>(null);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const latestProgressRef = useRef<number>(0);
  const updatePlaybackProgress = (val: number) => {
    latestProgressRef.current = val;
    setPlaybackProgress(val);
  };
  const [isPlaying, setIsPlaying] = useState(false);
  
  // Host-only: upcoming queue
  const [hostQueue, setHostQueue] = useState<PlayableSong[]>([]);
  
  // UI states
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isQrOpen, setIsQrOpen] = useState(false);
  const [isConfirmEndOpen, setIsConfirmEndOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [discoveredRooms, setDiscoveredRooms] = useState<DiscoveredRoom[]>([]);

  // Inactivity warning state
  const [isInactivityWarningOpen, setIsInactivityWarningOpen] = useState(false);
  const [inactivityCountdown, setInactivityCountdown] = useState(120);

  const filteredDiscoveredRooms = discoveredRooms.filter((r) => {
    const query = roomSearchQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      r.roomName.toLowerCase().includes(query) ||
      r.hostName.toLowerCase().includes(query) ||
      r.roomCode.toLowerCase().includes(query)
    );
  });

  const [isScanningQR, setIsScanningQR] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [backendHost, setBackendHost] = useState<string>(() => {
    const saved = localStorage.getItem('backend_host');
    const defaultHost = (import.meta.env.VITE_BACKEND_HOST as string) || window.location.hostname;
    const currentHost = window.location.hostname;
    const isCurrentLoopback = ['localhost', '127.0.0.1', '::1'].includes(currentHost);
    
    if (!isCurrentLoopback) {
      if (saved && !['localhost', '127.0.0.1', '::1'].includes(saved)) {
        return saved;
      }
      return defaultHost;
    }
    return saved || defaultHost;
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
  const isDraggingProgressRef = useRef(false);
  const loadedVideoIdRef = useRef<string>('');

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
            if (savedRole === 'guest') {
              setIsMuted(true);
            }
            setRoomCode(res.room.roomCode);
            setRoomName(res.room.roomName);
            setHostLocalIp(res.localIp);
            setMyUsername(res.username);
            setUsers(res.room.users);
            setCurrentSong(res.room.currentSong);
            
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

  // Inactivity countdown timer effect
  useEffect(() => {
    if (!isInactivityWarningOpen) return;

    const timer = window.setInterval(() => {
      setInactivityCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isInactivityWarningOpen]);

  // YouTube Player Initialization
  useEffect(() => {
    if (currentView !== 'player') return;

    let player: any = null;


    const initPlayer = () => {
      const container = document.getElementById('youtube-player');
      if (!container) return false;
      if (!window.YT || !window.YT.Player) return false;

      console.log("Initializing YouTube Player...");
      loadedVideoIdRef.current = currentSongRef.current?.url || '';
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
              if (userRole === 'host' && socketRef.current) {
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
      loadedVideoIdRef.current = '';
    };
  }, [userRole, currentView]);

  // Sync YouTube Player Playback for Everyone
  useEffect(() => {
    if (!ytPlayerRef.current || !isPlayerReady) return;
    const player = ytPlayerRef.current;

    if (currentSong) {
      const videoId = currentSong.url;

      if (loadedVideoIdRef.current !== videoId) {
        console.log("Loading new video ID:", videoId);
        loadedVideoIdRef.current = videoId;
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
      loadedVideoIdRef.current = '';
      setIsPlaying(false);
      updatePlaybackProgress(0);
    }
  }, [currentSong, isPlayerReady]);

  // Sync mute state for Everyone
  useEffect(() => {
    if (!ytPlayerRef.current || !isPlayerReady) return;
    if (isMuted) {
      ytPlayerRef.current.mute();
    } else {
      ytPlayerRef.current.unMute();
    }
  }, [isMuted, isPlayerReady]);

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
        if (isDraggingProgressRef.current) return;
        const progress = player.getCurrentTime();
        updatePlaybackProgress(progress);
        
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

  const getServerUrl = (host: string) => {
    return host.includes('://') 
      ? host 
      : `http://${host}${host.includes(':') ? '' : ':3001'}`;
  };

  // Connect to Socket.IO Server
  function connectSocket(targetHost: string = backendHost): Socket {
    if (socketRef.current) return socketRef.current;

    const serverUrl = getServerUrl(targetHost);
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
        updatePlaybackProgress(newSong.progress || 0);
        setIsPlaying(newSong.isPlaying);
      } else {
        updatePlaybackProgress(0);
        setIsPlaying(false);
      }
    });

    socket.on('playback:sync', ({ isPlaying: serverPlaying, progress }) => {
      setIsPlaying(serverPlaying);
      setCurrentSong(prev => prev ? { ...prev, isPlaying: serverPlaying } : null);
      
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
        
        // For guest, also sync progress if they are too far off (e.g. > 3 seconds)
        if (userRole !== 'host' && typeof player.getCurrentTime === 'function' && typeof player.seekTo === 'function') {
          const guestTime = player.getCurrentTime();
          if (Math.abs(guestTime - progress) > 3) {
            player.seekTo(progress, true);
          }
        }
      }

      if (userRole !== 'host' && !isDraggingProgressRef.current) {
        updatePlaybackProgress(progress);
      }
    });

    socket.on('playback:seek', ({ progress, isPlaying: serverPlaying }) => {
      updatePlaybackProgress(progress);
      setIsPlaying(serverPlaying);
      setCurrentSong(prev => prev ? { ...prev, isPlaying: serverPlaying, progress } : null);
      
      if (ytPlayerRef.current && isPlayerReady) {
        const player = ytPlayerRef.current;
        if (typeof player.seekTo === 'function') {
          player.seekTo(progress, true);
        }
      }
    });

    socket.on('user:kicked', ({ reason }) => {
      showToast(`You were removed from the room: ${reason}`, 'error');
      disconnectSession();
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

    socket.on('room:inactivity-warning', ({ warningTimeoutMs }) => {
      setInactivityCountdown(Math.round(warningTimeoutMs / 1000));
      setIsInactivityWarningOpen(true);
    });

    socket.on('room:inactivity-cancelled', () => {
      setIsInactivityWarningOpen(false);
    });

    socket.on('room:destroyed-inactivity', () => {
      showToast('The room was destroyed due to 1 hour of inactivity.', 'error');
      disconnectSession();
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
    updatePlaybackProgress(0);
    setIsPlaying(false);
    setHostQueue([]);
    setIsHostOnline(true);
    setDiscoveredRooms([]);
    setRoomCodeInput('');
    setIsInactivityWarningOpen(false);
    sessionStorage.removeItem('room_session');
    
    // Clean up URL search query parameters (remove ?room=CODE)
    try {
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch (e) {
      console.warn("Failed to clean up URL search parameters:", e);
    }

    setCurrentView('landing');
  }

  // Action: Create Room
  const handleCreateRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (!partyName.trim()) {
      showToast('Party Name is required.', 'error');
      return;
    }

    const hostNameClean = hostName.trim();
    if (!hostNameClean) {
      showToast('Nickname is required.', 'error');
      return;
    }
    if (hostNameClean.toLowerCase() === 'guest') {
      showToast('Please enter a valid name. "Guest" is not allowed.', 'error');
      return;
    }

    const socket = connectSocket();

    socket.emit('room:create', { 
      roomName: partyName, 
      hostName: hostNameClean,
      password: isPrivateRoom ? roomPassword : null
    }, (res: any) => {
      if (res.success) {
        setUserRole('host');
        setRoomCode(res.roomCode);
        setRoomName(partyName);
        setHostLocalIp(res.localIp);
        setMyUsername(hostNameClean);
        setUsers(res.room.users);
        setCurrentView('player');

        sessionStorage.setItem('room_session', JSON.stringify({
          roomCode: res.roomCode,
          roomName: partyName,
          role: 'host',
          myUsername: hostNameClean,
          backendHost: backendHost
        }));

        // Clear password state
        setRoomPassword('');
        setIsPrivateRoom(false);

        showToast('Room created successfully!', 'success');
      } else {
        showToast(res.message || 'Could not create room', 'error');
      }
    });
  };

  // Action: Join Room
  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const guestNameClean = guestName.trim();
    if (!roomCodeInput.trim() || !guestNameClean) {
      showToast('Room code and Nickname are required.', 'error');
      return;
    }
    if (guestNameClean.toLowerCase() === 'guest') {
      showToast('Please enter a valid name. "Guest" is not allowed.', 'error');
      return;
    }

    const socket = connectSocket();

    socket.emit('room:join', { 
      roomCode: roomCodeInput, 
      name: guestNameClean,
      password: joinPassword
    }, (res: any) => {
      if (res.success) {
        setUserRole('guest');
        setIsMuted(true); // Default to muted to bypass autoplay policy
        setRoomCode(res.room.roomCode);
        setRoomName(res.room.roomName);
        setHostLocalIp(res.localIp);
        setMyUsername(res.username);
        setUsers(res.room.users);
        setCurrentSong(res.room.currentSong);
        setCurrentView('player');

        sessionStorage.setItem('room_session', JSON.stringify({
          roomCode: res.room.roomCode,
          roomName: res.room.roomName,
          role: 'guest',
          myUsername: res.username,
          backendHost: backendHost
        }));

        // Clear password state
        setJoinPassword('');

        showToast(`Joined party room!`, 'success');
      } else {
        showToast(res.message || 'Room not found or incorrect password.', 'error');
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

  // Inactivity Warning: Continue activity
  const handleContinueRoomActivity = () => {
    if (socketRef.current) {
      socketRef.current.emit('room:continue-activity');
    }
  };

  // Host Session Control: Kick User
  const handleKickUser = (user: RoomUser) => {
    if (userRole !== 'host' || !socketRef.current) return;
    setKickTarget(user);
    setIsConfirmKickOpen(true);
  };

  const handleConfirmKickUser = () => {
    if (!socketRef.current || !kickTarget) return;
    socketRef.current.emit('user:kick', { socketId: kickTarget.socketId }, (res: any) => {
      if (res.success) {
        showToast(`Kicked ${kickTarget.name} from room`, 'success');
      } else {
        showToast(res.message || 'Failed to kick user', 'error');
      }
      setIsConfirmKickOpen(false);
      setKickTarget(null);
    });
  };

  // Host Session Control: End Room
  const handleEndRoom = () => {
    if (userRole !== 'host' || !socketRef.current) return;
    setIsConfirmEndOpen(true);
  };

  const handleConfirmEndRoom = () => {
    setIsConfirmEndOpen(false);
    if (socketRef.current) {
      socketRef.current.emit('room:end');
    }
    disconnectSession();
  };

  const handleProgressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    isDraggingProgressRef.current = true;
    updatePlaybackProgress(parseFloat(e.target.value));
  };

  const handleProgressSeek = () => {
    isDraggingProgressRef.current = false;
    if (socketRef.current) {
      socketRef.current.emit('playback:seek', { progress: latestProgressRef.current });
    }
  };

  // Discovery Action: Fetch Nearby Rooms
  const fetchNearbyRooms = async (silent = false) => {
    try {
      const serverUrl = getServerUrl(backendHost);
      const res = await fetch(`${serverUrl}/api/rooms`);
      if (res.ok) {
        const data = await res.json();
        setDiscoveredRooms(data);
      } else {
        if (!silent) {
          showToast('Could not fetch active rooms list.', 'error');
        }
      }
    } catch (err) {
      console.error(err);
      if (!silent) {
        showToast('Error discovering rooms. Is backend online?', 'error');
      }
    }
  };

  useEffect(() => {
    if (currentView === 'landing' || currentView === 'discovery' || currentView === 'join-room') {
      fetchNearbyRooms(true);
      // Poll active rooms list every 5 seconds
      const interval = setInterval(() => fetchNearbyRooms(true), 5000);
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

                <div className="flex items-center gap-2 py-1">
                  <input
                    id="is-private-room"
                    type="checkbox"
                    checked={isPrivateRoom}
                    onChange={(e) => setIsPrivateRoom(e.target.checked)}
                    className="w-4 h-4 rounded-sm bg-spotify-light-gray/60 border-white/10 text-spotify-green focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  <label htmlFor="is-private-room" className="text-xs font-bold uppercase tracking-wider text-spotify-text cursor-pointer select-none">
                    Private Room (Password Protected)
                  </label>
                </div>

                {isPrivateRoom && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-2"
                  >
                    <label htmlFor="room-password" className="block text-xs font-bold uppercase tracking-wider text-spotify-text mb-2">
                      Room Password
                    </label>
                    <input
                      id="room-password"
                      type="password"
                      required={isPrivateRoom}
                      placeholder="Enter room password"
                      value={roomPassword}
                      onChange={(e) => setRoomPassword(e.target.value)}
                      className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-sm font-semibold tracking-wide"
                    />
                  </motion.div>
                )}

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

                  {(() => {
                    const targetDiscoveredRoom = discoveredRooms.find(r => r.roomCode.toUpperCase() === roomCodeInput.toUpperCase());
                    const isTargetPrivate = targetDiscoveredRoom ? targetDiscoveredRoom.isPrivate : false;
                    const showPasswordInput = targetDiscoveredRoom ? isTargetPrivate : true;
                    
                    return showPasswordInput && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-2 text-left"
                      >
                        <label htmlFor="join-password" className="block text-xs font-bold uppercase tracking-wider text-spotify-text mb-2">
                          Room Password {targetDiscoveredRoom ? '' : '(Optional)'}
                        </label>
                        <input
                          id="join-password"
                          type="password"
                          required={isTargetPrivate}
                          placeholder={isTargetPrivate ? "Enter room password" : "Enter password if private"}
                          value={joinPassword}
                          onChange={(e) => setJoinPassword(e.target.value)}
                          className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-sm font-semibold tracking-wide"
                        />
                      </motion.div>
                    );
                  })()}

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
              {filteredDiscoveredRooms.length > 0 && (
                <div className="glass-panel p-6 rounded-2xl border border-white/5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-spotify-text mb-4">
                    Active Nearby Parties on WiFi
                  </h3>
                  <div className="space-y-3">
                    {filteredDiscoveredRooms.map((r) => (
                      <div 
                        key={r.roomCode}
                        onClick={() => selectDiscoveredRoom(r.roomCode)}
                        className="flex items-center justify-between p-3 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-spotify-green/20 rounded-xl transition group cursor-pointer"
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <div className="flex items-center gap-1.5">
                            <h4 className="text-sm font-bold text-white group-hover:text-spotify-green transition truncate">{r.roomName}</h4>
                            {r.isPrivate && <span title="Private Room"><Lock className="w-3.5 h-3.5 text-spotify-green/80 flex-shrink-0" /></span>}
                          </div>
                          <p className="text-xs text-spotify-text mt-0.5">Host: {r.hostName} • {r.userCount} listening</p>
                        </div>
                        <span className="px-2.5 py-1 rounded bg-spotify-green/10 text-spotify-green text-xs font-extrabold font-mono uppercase tracking-wider flex-shrink-0">
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
                  <h2 className="text-3xl font-extrabold font-sans">Discover Parties</h2>
                  <p className="text-spotify-text text-sm mt-1">Automatic discovery of local network sessions</p>
                </div>
                <button
                  onClick={() => fetchNearbyRooms()}
                  className="p-2 rounded-full hover:bg-white/10 text-spotify-text hover:text-white transition cursor-pointer"
                  title="Refresh lists"
                >
                  <Compass className="w-5 h-5 text-spotify-green animate-spin" style={{ animationDuration: '6s' }} />
                </button>
              </div>

              {/* Room Search Input */}
              <div className="relative mb-6">
                <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-spotify-text">
                  <Search className="w-4 h-4" />
                </span>
                <input
                  type="text"
                  placeholder="Search parties by name, host, or code..."
                  value={roomSearchQuery}
                  onChange={(e) => setRoomSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-10 py-3 bg-white/5 border border-white/5 hover:border-white/10 focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 rounded-xl text-white placeholder-spotify-text focus:outline-hidden transition text-sm"
                />
                {roomSearchQuery && (
                  <button
                    onClick={() => setRoomSearchQuery('')}
                    className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-spotify-text hover:text-white transition cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {filteredDiscoveredRooms.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center text-spotify-text">
                  <Radio className="w-12 h-12 mb-4 stroke-[1.5] text-spotify-text/30 animate-pulse" />
                  <p className="font-semibold text-white">No active parties found</p>
                  <p className="text-xs max-w-xs mt-2">
                    {roomSearchQuery 
                      ? "Try searching for a different room name, host, or room code." 
                      : "Make sure an admin has created a room. Everyone must be connected to the same local WiFi."}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {filteredDiscoveredRooms.map((r) => (
                    <div 
                      key={r.roomCode}
                      className="p-4 bg-white/5 border border-white/5 rounded-xl flex items-center justify-between gap-4 hover:border-spotify-green/30 transition group"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-white group-hover:text-spotify-green transition truncate">{r.roomName}</h3>
                          {r.isPrivate && <span title="Private Room"><Lock className="w-4 h-4 text-spotify-green/80 flex-shrink-0" /></span>}
                        </div>
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
                        className="px-4 py-2 rounded-full bg-spotify-green text-black font-extrabold hover:scale-105 active:scale-95 transition text-xs cursor-pointer flex-shrink-0"
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

                  {/* Widescreen Video Viewport for Everyone */}
                  <div className="relative mb-8 w-full aspect-video flex items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-black/60 shadow-2xl">
                    {/* YouTube player element must be present in the DOM always to avoid iframe recreation issues */}
                    <div className={`w-full h-full transition-opacity duration-300 ${currentSong ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                      <YouTubePlaceholder />
                    </div>
                    
                    {!currentSong && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center text-spotify-text">
                        <Music className="w-12 h-12 mb-2 stroke-[1.5] text-spotify-text/30 animate-pulse" />
                        <p className="text-xs">No active video stream</p>
                      </div>
                    )}
                  </div>

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
                    <input
                      type="range"
                      min={0}
                      max={currentSong ? currentSong.duration : 100}
                      value={playbackProgress}
                      onChange={handleProgressChange}
                      onMouseUp={handleProgressSeek}
                      onTouchEnd={handleProgressSeek}
                      disabled={!currentSong}
                      className="w-full h-1 bg-white/10 rounded-full appearance-none cursor-pointer accent-spotify-green focus:outline-hidden"
                      style={{
                        background: `linear-gradient(to right, #1db954 0%, #1db954 ${currentSong ? (playbackProgress / currentSong.duration) * 100 : 0}%, rgba(255,255,255,0.1) ${currentSong ? (playbackProgress / currentSong.duration) * 100 : 0}%, rgba(255,255,255,0.1) 100%)`
                      }}
                    />
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
                      <>
                        {/* Mute output button for Guest */}
                        <button
                          onClick={() => setIsMuted(!isMuted)}
                          className={`p-2.5 rounded-full transition border cursor-pointer ${
                            isMuted 
                              ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20' 
                              : 'bg-white/5 border-white/5 text-spotify-text hover:text-white hover:bg-white/10'
                          }`}
                          title={isMuted ? 'Unmute local player' : 'Mute local player'}
                        >
                          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                        </button>

                        {/* Guest View Suggest Track Action */}
                        <button
                          onClick={() => setIsSearchOpen(true)}
                          className="px-6 py-3.5 rounded-full bg-spotify-green text-black font-extrabold flex items-center justify-center gap-2 hover:scale-105 active:scale-95 transition shadow-lg cursor-pointer text-sm"
                        >
                          <Plus className="w-4 h-4 stroke-[3]" /> Suggest a Song
                        </button>
                      </>
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
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all duration-300 ${
                          u.isHost
                            ? 'bg-spotify-green/10 border-spotify-green/30 text-spotify-green font-bold'
                            : 'bg-white/5 border-white/5 text-white'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${u.isHost ? 'bg-spotify-green animate-pulse' : 'bg-emerald-400'} flex-shrink-0`}></span>
                        <span className="truncate max-w-[120px]" title={u.name}>{u.name}</span>
                        {u.isHost && <span className="text-xxs opacity-70">(Host)</span>}
                        {userRole === 'host' && u.ip && (
                          <span 
                            className="text-[9px] opacity-40 font-mono select-all bg-black/30 px-1 rounded ml-0.5" 
                            title={`IP Address: ${u.ip}`}
                          >
                            {u.ip === '::1' || u.ip === '127.0.0.1' || u.ip?.includes('127.0.0.1') 
                              ? 'localhost' 
                              : u.ip.replace('::ffff:', '')}
                          </span>
                        )}
                        {userRole === 'host' && !u.isHost && (
                          <button
                            type="button"
                            onClick={() => handleKickUser(u)}
                            className="p-0.5 rounded-full hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors ml-1 cursor-pointer flex items-center justify-center"
                            title={`Remove ${u.name} from party`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
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
        LocalParty © {new Date().getFullYear()} • Created by junior developers of EmergingCoders
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

      <ConfirmationModal
        isOpen={isConfirmEndOpen}
        onClose={() => setIsConfirmEndOpen(false)}
        onConfirm={handleConfirmEndRoom}
        title="End Party Room"
        message="Are you sure you want to end the party room session? This will disconnect all guests."
        confirmText="Yes, End Party"
        cancelText="Cancel"
      />

      <ConfirmationModal
        isOpen={isConfirmKickOpen}
        onClose={() => {
          setIsConfirmKickOpen(false);
          setKickTarget(null);
        }}
        onConfirm={handleConfirmKickUser}
        title="Remove Member"
        message={`Are you sure you want to remove ${kickTarget?.name || 'this user'} from the room? All songs suggested by this user will also be removed from the playlist.`}
        confirmText="Remove User"
        cancelText="Cancel"
      />

      <InactivityWarningModal
        isOpen={isInactivityWarningOpen}
        countdown={inactivityCountdown}
        onContinue={handleContinueRoomActivity}
      />

    </div>
  );
}

export default App;
