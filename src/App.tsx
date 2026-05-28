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
  Lock,
  X,
  Search,
  ShieldAlert,
  ArrowUp,
  ArrowDown,
  Upload
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { SongSearchModal } from './components/SongSearchModal';
import { RoomQRModal } from './components/RoomQRModal';
import { ConfirmationModal } from './components/ConfirmationModal';
import { InactivityWarningModal } from './components/InactivityWarningModal';
import { FeedbackModal } from './components/FeedbackModal';
import type { Song, PlayableSong } from './types';
import './App.css';

const getSystemIpAddress = (): Promise<string> => {
  return new Promise((resolve) => {
    try {
      const RTCPeerConnectionClass = window.RTCPeerConnection || 
        (window as any).webkitRTCPeerConnection || 
        (window as any).mozRTCPeerConnection;
        
      if (!RTCPeerConnectionClass) {
        resolve('');
        return;
      }

      const pc = new RTCPeerConnectionClass({ iceServers: [] });
      pc.createDataChannel('');
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => {});
      
      let resolved = false;
      pc.onicecandidate = (ice) => {
        if (resolved) return;
        if (!ice || !ice.candidate || !ice.candidate.candidate) {
          return;
        }
        const candidate = ice.candidate.candidate;
        // Look for an IPv4 address
        const ipRegex = /([0-9]{1,3}(\.[0-9]{1,3}){3})/;
        const match = candidate.match(ipRegex);
        if (match) {
          resolved = true;
          resolve(match[1]);
          pc.close();
        } else {
          // Look for an IPv6 or mDNS address (.local)
          const mdnsRegex = /([a-zA-Z0-9-]+\.local)/;
          const mdnsMatch = candidate.match(mdnsRegex);
          if (mdnsMatch) {
            resolved = true;
            resolve(mdnsMatch[1]);
            pc.close();
          }
        }
      };
      
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          pc.close();
          resolve('');
        }
      }, 500);
    } catch (e) {
      resolve('');
    }
  });
};


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
  isLocal?: boolean;
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
  const [isUnlistedRoom, setIsUnlistedRoom] = useState(false);
  const [joinPassword, setJoinPassword] = useState('');
  
  // Active Room details
  const [roomCode, setRoomCode] = useState('');
  const [roomName, setRoomName] = useState('');
  const [hostLocalIp, setHostLocalIp] = useState('');
  const [clientSystemIp, setClientSystemIp] = useState('');
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
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
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
  
  // Customizable Guest Room Permissions
  const [allowGuestSkip, setAllowGuestSkip] = useState(true);
  const [allowGuestSeek, setAllowGuestSeek] = useState(false);
  const [allowGuestPlayPause, setAllowGuestPlayPause] = useState(true);
  const [guestMuteByDefault, setGuestMuteByDefault] = useState(true);
  const [displayGuestVideo, setDisplayGuestVideo] = useState(false);

  // Active Session Permissions & prospective autoplay states
  const [roomPermissions, setRoomPermissions] = useState<any>(null);
  const [autoplayQueue, setAutoplayQueue] = useState<PlayableSong[]>([]);
  const [showPermissionsConfig, setShowPermissionsConfig] = useState(false);
  const [isArchived, setIsArchived] = useState(false);

  const isLocalHostAddress = (hostStr: string) => {
    if (!hostStr) return false;
    const clean = hostStr.replace(/^https?:\/\//, '').split(':')[0];
    return ['localhost', '127.0.0.1', '::1'].includes(clean) || 
      clean.startsWith('192.168.') || 
      clean.startsWith('192.138.') || 
      clean.startsWith('10.') || 
      clean.startsWith('172.') ||
      clean.endsWith('.local');
  };

  const [backendHost, setBackendHost] = useState<string>(() => {
    const envHost = import.meta.env.VITE_BACKEND_HOST as string;
    const hostname = window.location.hostname;
    
    const isLocalHostname = isLocalHostAddress(hostname);
    const isLocalEnvHost = envHost && isLocalHostAddress(envHost);
    
    // If running/testing locally via local hostname or local env variable, enforce local server
    if (isLocalHostname || isLocalEnvHost) {
      if (envHost) {
        return envHost;
      }
      const protocol = window.location.protocol === 'https:' ? 'https://' : 'http://';
      const cleanHostname = hostname.replace(/^https?:\/\//, '').split(':')[0];
      return `${protocol}${cleanHostname}:3001`;
    }

    // In production, prioritize the environment variable VITE_BACKEND_HOST over localStorage
    if (envHost) return envHost;

    const saved = localStorage.getItem('backend_host');
    if (saved) return saved;

    // Default global production backend
    return 'local-party-backend.onrender.com';
  });

  const [isHostOnline, setIsHostOnline] = useState(true);

  // Resolve client local LAN IP on mount for sharing links fallback
  useEffect(() => {
    getSystemIpAddress().then((resolved) => {
      if (resolved && (
        resolved.startsWith('192.168.') || 
        resolved.startsWith('192.138.') || 
        resolved.startsWith('10.') || 
        resolved.startsWith('172.')
      )) {
        setClientSystemIp(resolved);
      }
    });
  }, []);

  const [isScrolled, setIsScrolled] = useState(false);

  // Monitor page scroll to apply dynamic glassmorphic navbar styles
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);
  
  // Refs
  const socketRef = useRef<Socket | null>(null);
  const ytPlayerRef = useRef<any>(null);
  const progressIntervalRef = useRef<number | null>(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const currentSongRef = useRef<PlayableSong | null>(null);
  const isDraggingProgressRef = useRef(false);
  const loadedVideoIdRef = useRef<string>('');
  const watchdogCountRef = useRef<number>(0);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const qrScanTimeoutRef = useRef<any>(null);

  const userRoleRef = useRef<string | null>(null);
  const currentViewRef = useRef<string>('landing');
  const roomCodeRef = useRef<string>('');
  const isPlayerReadyRef = useRef<boolean>(false);

  useEffect(() => {
    userRoleRef.current = userRole;
  }, [userRole]);

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    roomCodeRef.current = roomCode;
  }, [roomCode]);

  useEffect(() => {
    isPlayerReadyRef.current = isPlayerReady;
  }, [isPlayerReady]);

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

  // Clean up QR scan timer on unmount
  useEffect(() => {
    return () => {
      if (qrScanTimeoutRef.current) {
        clearTimeout(qrScanTimeoutRef.current);
      }
    };
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

        connectSocket(currentHost);
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
                socketRef.current.emit('song:skip', { songId: currentSongRef.current?.id });
              }
            }
          },
          onError: (event: any) => {
            console.error("YouTube Player Error:", event.data);
            if (userRole === 'host' && socketRef.current && currentSongRef.current) {
              socketRef.current.emit('playback:error', {
                songId: currentSongRef.current.id,
                errorCode: event.data
              });
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

  // Sync mute state for Everyone (with explicit volume set to prevent silent unmutes)
  useEffect(() => {
    if (!ytPlayerRef.current || !isPlayerReady) return;
    try {
      if (isMuted) {
        if (typeof ytPlayerRef.current.mute === 'function') {
          ytPlayerRef.current.mute();
        }
      } else {
        if (typeof ytPlayerRef.current.unMute === 'function') {
          ytPlayerRef.current.unMute();
        }
        if (typeof ytPlayerRef.current.setVolume === 'function') {
          ytPlayerRef.current.setVolume(50);
        }
      }
    } catch (e) {
      console.warn("Error setting volume/mute state:", e);
    }
  }, [isMuted, isPlayerReady]);

  // Handle global mouse/touch release for progress slider seeking
  useEffect(() => {
    const handleGlobalRelease = () => {
      if (isDraggingProgressRef.current) {
        isDraggingProgressRef.current = false;
        if (socketRef.current) {
          socketRef.current.emit('playback:seek', { progress: latestProgressRef.current });
        }
      }
    };

    window.addEventListener('mouseup', handleGlobalRelease);
    window.addEventListener('touchend', handleGlobalRelease);
    return () => {
      window.removeEventListener('mouseup', handleGlobalRelease);
      window.removeEventListener('touchend', handleGlobalRelease);
    };
  }, []);

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
        const isActuallyPlaying = playerState === 1 || playerState === 3;

        // Watchdog: auto-skip if playing but stuck at 0s for 8s
        // At 300ms intervals, 8 seconds is ~26 checks
        if (isActuallyPlaying && progress === 0) {
          watchdogCountRef.current += 1;
          if (watchdogCountRef.current >= 26) {
            console.warn("Watchdog detected frozen playback (stuck at 0 for 8s). Triggering auto-skip.");
            watchdogCountRef.current = 0;
            socketRef.current.emit('playback:error', {
              songId: currentSong.id,
              errorCode: 'watchdog_timeout'
            });
          }
        } else {
          watchdogCountRef.current = 0;
        }

        socketRef.current.emit('playback:progress-update', {
          progress,
          isPlaying: isActuallyPlaying
        });
      }
    }, 300);

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
        progressIntervalRef.current = null;
      }
    };
  }, [userRole, isPlaying, currentSong, isPlayerReady]);

  // Local progression loop: smoothly increments progress slider locally by 0.1s every 100ms when playing
  useEffect(() => {
    if (!isPlaying || !currentSong) return;
    
    const interval = window.setInterval(() => {
      if (isDraggingProgressRef.current) return;
      updatePlaybackProgress(latestProgressRef.current + 0.1);
    }, 100);
    
    return () => window.clearInterval(interval);
  }, [isPlaying, currentSong]);

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

    let connectErrorCount = 0;
    socket.on('connect_error', () => {
      connectErrorCount++;
      if (connectErrorCount === 1) {
        const isLocal = isLocalHostAddress(targetHost);
        showToast(
          isLocal 
            ? 'Connecting to local server...' 
            : 'Connecting to server (waking up Render backend if idle)...', 
          'info'
        );
      } else if (connectErrorCount % 5 === 0) {
        showToast('Connection to server is taking longer than usual. Please verify if server.js is running.', 'error');
      }
    });

    socket.on('connect', () => {
      connectErrorCount = 0;
      console.log(`Socket connected: ${socket.id}`);
      
      if (roomCodeRef.current) {
        showToast('Connected back to server!', 'success');
      }

      const savedSession = sessionStorage.getItem('room_session');
      if (savedSession) {
        try {
          const { roomCode: savedRoomCode, role: savedRole, myUsername: savedUsername, password: savedPassword } = JSON.parse(savedSession);
          if (savedRoomCode && savedRole && savedUsername) {
            getSystemIpAddress().then((resolvedIp) => {
              socket.emit('room:reconnect', {
                roomCode: savedRoomCode,
                role: savedRole,
                username: savedUsername,
                password: savedPassword || undefined,
                systemIp: resolvedIp || undefined
              }, (res: any) => {
                if (res.success) {
                console.log(`Successfully reconnected to room ${savedRoomCode}`);
                setUserRole(savedRole);
                setRoomPermissions(res.room.permissions);
                setAutoplayQueue(res.autoplayQueue || []);
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
                
                if (!roomCodeRef.current) {
                  showToast(`Restored session in room ${res.room.roomCode}!`, 'success');
                }
              } else {
                console.warn(`Session restoration failed: ${res.message}`);
                showToast(res.message || 'Session expired or room not found on server.', 'error');
                disconnectSession();
              }
            });
          });
          }
        } catch (e) {
          console.error('Failed to parse saved session on connect:', e);
        }
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`Socket disconnected: ${reason}`);
      // Show error toast if disconnect was unexpected (socketRef is still active)
      if (socketRef.current) {
        showToast('Connection to server lost. Reconnecting...', 'error');
      }
    });

    // Listeners for both Host & Guest
    socket.on('room:user-update', (updatedUsers: RoomUser[]) => {
      setUsers(updatedUsers);
    });

    socket.on('room:permissions-update', (updatedPermissions) => {
      setRoomPermissions(updatedPermissions);
      showToast('Room permissions updated by host', 'info');
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
      setCurrentSong(prev => {
        if (!prev) return null;
        if (prev.isPlaying === serverPlaying) return prev;
        return { ...prev, isPlaying: serverPlaying };
      });
      
      if (ytPlayerRef.current && isPlayerReadyRef.current) {
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
        
        // For guest, also sync progress if they are too far off (e.g. > 3.0 seconds)
        if (userRoleRef.current !== 'host' && typeof player.getCurrentTime === 'function' && typeof player.seekTo === 'function') {
          const guestTime = player.getCurrentTime();
          if (Math.abs(guestTime - progress) > 3.0) {
            player.seekTo(progress, true);
          }
        }
      }

      if (userRoleRef.current !== 'host' && !isDraggingProgressRef.current) {
        updatePlaybackProgress(progress);
      }
    });

    socket.on('playback:seek', ({ progress, isPlaying: serverPlaying }) => {
      updatePlaybackProgress(progress);
      setIsPlaying(serverPlaying);
      setCurrentSong(prev => prev ? { ...prev, isPlaying: serverPlaying, progress } : null);
      
      if (ytPlayerRef.current && isPlayerReadyRef.current) {
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
      showToast('Admin has closed the room.', 'info');
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

    socket.on('autoplayQueue:update', (updatedAutoplayQueue: PlayableSong[]) => {
      setAutoplayQueue(updatedAutoplayQueue);
    });

    socket.on('room:inactivity-warning', ({ warningTimeoutMs }) => {
      setInactivityCountdown(Math.round(warningTimeoutMs / 1000));
      setIsInactivityWarningOpen(true);
    });

    socket.on('room:inactivity-cancelled', () => {
      setIsInactivityWarningOpen(false);
    });

    socket.on('room:destroyed-inactivity', () => {
      setIsArchived(true);
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
      const tempSocket = socketRef.current;
      socketRef.current = null;
      tempSocket.disconnect();
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
    setAutoplayQueue([]);
    setRoomPermissions(null);
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

    getSystemIpAddress().then((resolvedIp) => {
      socket.emit('room:create', { 
        roomName: partyName, 
        hostName: hostNameClean,
        password: isPrivateRoom ? roomPassword : null,
        isUnlisted: isUnlistedRoom,
        systemIp: resolvedIp || undefined,
        permissions: {
          allowGuestSkip,
          allowGuestSeek,
          allowGuestPlayPause,
          guestMuteByDefault,
          displayGuestVideo
        }
      }, (res: any) => {
        if (res.success) {
          setUserRole('host');
          setRoomPermissions(res.room.permissions);
          setAutoplayQueue([]);
          setRoomCode(res.roomCode);
          setRoomName(partyName);
          setHostLocalIp(res.localIp);
          setMyUsername(hostNameClean);
          setUsers(res.room.users);
          setCurrentView('player');

          const cleanPassword = isPrivateRoom ? roomPassword.trim() : null;
          sessionStorage.setItem('room_session', JSON.stringify({
            roomCode: res.roomCode,
            roomName: partyName,
            role: 'host',
            myUsername: hostNameClean,
            backendHost: backendHost,
            password: cleanPassword || undefined
          }));

          // Clear password and unlisted states
          setRoomPassword('');
          setIsPrivateRoom(false);
          setIsUnlistedRoom(false);

          showToast('Room created successfully!', 'success');
        } else {
          showToast(res.message || 'Could not create room', 'error');
        }
      });
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

    getSystemIpAddress().then((resolvedIp) => {
      socket.emit('room:join', { 
        roomCode: roomCodeInput, 
        name: guestNameClean,
        password: joinPassword,
        systemIp: resolvedIp || undefined
      }, (res: any) => {
        if (res.success) {
          setUserRole('guest');
          setRoomPermissions(res.room.permissions);
          setAutoplayQueue([]);
          // Initial mute state: default to muted if permissions specify guestMuteByDefault
          setIsMuted(res.room.permissions?.guestMuteByDefault ?? true);
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
            backendHost: backendHost,
            password: joinPassword.trim() || undefined
          }));

          // Clear password state
          setJoinPassword('');

          showToast(`Joined party room!`, 'success');
        } else {
          showToast(res.message || 'Room not found or incorrect password.', 'error');
          socketRef.current = null;
          socket.disconnect();
        }
      });
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
          showToast(res.message || 'Failed to add song.', 'error');
          resolve(false);
        }
      });
    });
  };

  // Playback Control: Play / Pause (restricted by permissions)
  const handlePlayPause = (explicitState?: boolean) => {
    if (!socketRef.current || !currentSong) return;

    // Check permission: host, or guest if allowGuestPlayPause is true
    const isAllowed = userRole === 'host' || roomPermissions?.allowGuestPlayPause;
    if (!isAllowed) {
      showToast('You do not have permission to play/pause.', 'error');
      return;
    }
    
    const newPlayingState = explicitState !== undefined ? explicitState : !isPlaying;
    
    // If host or guest, we can emit playback state change
    if (ytPlayerRef.current && isPlayerReady) {
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

  // Playback Control: Skip (restricted by permissions)
  const handleSkip = () => {
    if (!socketRef.current) return;
    const isAllowed = userRole === 'host' || roomPermissions?.allowGuestSkip;
    if (!isAllowed) {
      showToast('You do not have permission to skip.', 'error');
      return;
    }
    socketRef.current.emit('song:skip', { songId: currentSongRef.current?.id });
    showToast('Skipped song', 'info');
  };

  // Host Queue Control: Remove
  const handleRemoveFromQueue = (songId: string) => {
    if (userRole !== 'host' || !socketRef.current) return;
    socketRef.current.emit('song:remove-from-queue', { songId });
    showToast('Song removed from queue', 'info');
  };

  // Queue reorder emitter (restricted to host)
  const handleReorderQueue = (newQueue: PlayableSong[]) => {
    if (userRole !== 'host' || !socketRef.current) return;
    setHostQueue(newQueue);
    socketRef.current.emit('queue:reorder', { queueIds: newQueue.map(q => q.id) });
  };

  const updateSinglePermission = (key: string, value: boolean) => {
    if (userRole !== 'host' || !socketRef.current) return;
    const updatedPermissions = {
      ...roomPermissions,
      [key]: value
    };
    setRoomPermissions(updatedPermissions);
    socketRef.current.emit('room:update-permissions', { permissions: updatedPermissions });
  };

  const moveSongUp = (idx: number) => {
    if (idx <= 0) return;
    const newQueue = [...hostQueue];
    const temp = newQueue[idx];
    newQueue[idx] = newQueue[idx - 1];
    newQueue[idx - 1] = temp;
    handleReorderQueue(newQueue);
  };

  const moveSongDown = (idx: number) => {
    if (idx >= hostQueue.length - 1) return;
    const newQueue = [...hostQueue];
    const temp = newQueue[idx];
    newQueue[idx] = newQueue[idx + 1];
    newQueue[idx + 1] = temp;
    handleReorderQueue(newQueue);
  };

  const moveSongToTop = (idx: number) => {
    if (idx <= 0) return;
    const newQueue = [...hostQueue];
    const song = newQueue.splice(idx, 1)[0];
    newQueue.unshift(song);
    handleReorderQueue(newQueue);
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
    // If guest and seeks are disabled, prevent dragging
    const isAllowed = userRole === 'host' || roomPermissions?.allowGuestSeek;
    if (!isAllowed) return;

    isDraggingProgressRef.current = true;
    updatePlaybackProgress(parseFloat(e.target.value));
  };

  const handleProgressSeek = () => {
    const isAllowed = userRole === 'host' || roomPermissions?.allowGuestSeek;
    if (!isAllowed) return;

    isDraggingProgressRef.current = false;
    if (socketRef.current) {
      socketRef.current.emit('playback:seek', { progress: latestProgressRef.current });
    }
  };

  const handleSeekOffset = (offset: number) => {
    if (!currentSong || !socketRef.current) return;
    const isAllowed = userRole === 'host' || roomPermissions?.allowGuestSeek;
    if (!isAllowed) {
      showToast('You do not have permission to seek.', 'error');
      return;
    }

    const newProgress = Math.max(0, Math.min(currentSong.duration, latestProgressRef.current + offset));
    updatePlaybackProgress(newProgress);
    
    if (ytPlayerRef.current && isPlayerReady) {
      try {
        ytPlayerRef.current.seekTo(newProgress, true);
      } catch (err) {
        console.warn("YouTube seek offset failed", err);
      }
    }
    socketRef.current.emit('playback:seek', { progress: newProgress });
  };

  // Mobile background audio silent looping & mediaSession integrations
  useEffect(() => {
    const silentAudio = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA");
    silentAudio.loop = true;
    silentAudioRef.current = silentAudio;

    return () => {
      silentAudio.pause();
      silentAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const silentAudio = silentAudioRef.current;
    if (!silentAudio) return;

    if (isPlaying && currentSong) {
      silentAudio.play().catch(err => {
        console.warn("Silent background audio play blocked/failed", err);
      });
    } else {
      silentAudio.pause();
    }
  }, [isPlaying, currentSong]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    if (currentSong) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentSong.title,
        artist: currentSong.artist,
        album: currentSong.album || 'LocalParty',
        artwork: [
          { src: currentSong.albumArt || '/logo.png', sizes: '96x96', type: 'image/jpeg' },
          { src: currentSong.albumArt || '/logo.png', sizes: '128x128', type: 'image/jpeg' },
          { src: currentSong.albumArt || '/logo.png', sizes: '192x192', type: 'image/jpeg' },
          { src: currentSong.albumArt || '/logo.png', sizes: '256x256', type: 'image/jpeg' },
          { src: currentSong.albumArt || '/logo.png', sizes: '384x384', type: 'image/jpeg' },
          { src: currentSong.albumArt || '/logo.png', sizes: '512x512', type: 'image/jpeg' },
        ]
      });

      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    } else {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }
  }, [currentSong, isPlaying]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;

    try {
      navigator.mediaSession.setActionHandler('play', () => {
        handlePlayPause(true);
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        handlePlayPause(false);
      });
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const offset = details.seekOffset || -10;
        handleSeekOffset(offset);
      });
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const offset = details.seekOffset || 10;
        handleSeekOffset(offset);
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        handleSeekOffset(-10);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        handleSkip();
      });
    } catch (err) {
      console.warn("Failed to set Media Session action handlers", err);
    }

    return () => {
      if (!('mediaSession' in navigator)) return;
      try {
        navigator.mediaSession.setActionHandler('play', null);
        navigator.mediaSession.setActionHandler('pause', null);
        navigator.mediaSession.setActionHandler('seekbackward', null);
        navigator.mediaSession.setActionHandler('seekforward', null);
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      } catch (err) {
        console.warn("Failed to clear Media Session action handlers", err);
      }
    };
  }, [currentSong, isPlaying, roomPermissions, userRole]);

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

  const handleSimulateQRScan = () => {
    setIsScanningQR(true);
    if (qrScanTimeoutRef.current) {
      clearTimeout(qrScanTimeoutRef.current);
    }
    // Simulate camera activation delay, then auto-fill code if present in URL, or mock fill
    qrScanTimeoutRef.current = setTimeout(() => {
      setIsScanningQR(false);
      qrScanTimeoutRef.current = null;
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

  const handleCancelQRScan = () => {
    if (qrScanTimeoutRef.current) {
      clearTimeout(qrScanTimeoutRef.current);
      qrScanTimeoutRef.current = null;
    }
    setIsScanningQR(false);
    showToast("QR scanning cancelled.", "info");
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const minutes = Math.floor(secs / 60);
    const seconds = Math.floor(secs % 60);
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  if (isArchived) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-spotify-black p-6">
        <div className="absolute inset-0 opacity-[0.03] bg-[radial-gradient(#fff_1px,transparent_1px)] bg-[size:10px_10px] pointer-events-none"></div>
        
        {/* Ambient glowing orb */}
        <div className="absolute w-96 h-96 rounded-full blur-[120px] bg-red-500/10 pointer-events-none"></div>
        
        <div className="w-full max-w-sm glass-panel p-8 rounded-3xl text-center border border-red-500/20 shadow-2xl flex flex-col items-center">
          <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center mb-6">
            <ShieldAlert className="w-8 h-8 text-red-500 animate-pulse" />
          </div>
          
          <h2 className="text-2xl font-black mb-3 tracking-wide text-white uppercase bg-gradient-to-r from-white via-white to-red-400 bg-clip-text text-transparent">
            Session Archived
          </h2>
          
          <p className="text-xs text-spotify-text leading-relaxed mb-8 px-2">
            This room has been destroyed automatically after 1 hour of inactivity to keep the party performance optimal.
          </p>
          
          <button
            onClick={() => {
              setIsArchived(false);
              setCurrentView('landing');
            }}
            className="w-full py-4 rounded-full bg-spotify-green text-black font-extrabold text-sm hover:scale-102 active:scale-98 transition-all cursor-pointer shadow-lg shadow-spotify-green/20 hover:bg-green-400"
          >
            Return to Lobby
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-spotify-black text-white flex flex-col relative">
      
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

      {/* Grid Decorative Particles Backdrop - Fixed and hardware accelerated to eliminate scroll lag */}
      <div className="fixed inset-0 pointer-events-none z-0 select-none" style={{ transform: 'translate3d(0, 0, 0)' }}>
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] bg-spotify-green/10 rounded-full blur-[120px] will-change-transform"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-purple-500/10 rounded-full blur-[120px] will-change-transform"></div>
        <div className="absolute inset-0 opacity-[0.02] bg-[linear-gradient(to_right,#808080_1px,transparent_1px),linear-gradient(to_bottom,#808080_1px,transparent_1px)] bg-[size:24px_24px]"></div>
      </div>

      {/* Main Layout - Modern glass navbar (always glassmorphic, transitions on scroll) */}
      <header className={`w-full sticky top-0 z-50 transition-all duration-300 border-b bg-spotify-black/40 backdrop-blur-md border-white/5 py-4 ${
        isScrolled 
          ? 'bg-spotify-black/70 backdrop-blur-lg border-white/10 shadow-[0_4px_30px_rgba(0,0,0,0.5)] py-2.5 shadow-md' 
          : ''
      }`}>
        <div className="w-full max-w-7xl mx-auto px-6 flex items-center justify-between">
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
        </div>
      </header>

      <div className="w-full flex-1 flex justify-center z-10 relative max-w-[1600px] mx-auto px-6 gap-6">
        {/* Left Sidebar Ad Slot - Hidden (will work on it later) */}
        <div className="hidden w-[200px] flex-shrink-0 flex-col gap-4 py-8">
          <div className="glass-panel p-4 rounded-2xl border border-white/5 h-[600px] sticky top-[100px] flex flex-col items-center justify-center text-center text-spotify-text text-xxs font-bold uppercase tracking-wider">
            <span className="text-white/20 mb-3 block">Sponsored Ad</span>
            <div className="flex-grow w-full bg-white/2 rounded-xl border border-white/5 flex flex-col items-center justify-center p-4">
              <span className="text-white/10 font-bold mb-1">LocalParty</span>
              <span className="text-white/5 font-semibold text-[10px] normal-case text-center">Synchronized Playback Worldwide</span>
            </div>
          </div>
        </div>

        {/* Central main content area */}
        <main className="flex-1 w-full max-w-5xl py-8 flex flex-col justify-center items-center relative min-w-0 mx-auto">
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
                Synchronized Social Music Surprise Queue System
              </div>

              {/* Tagline */}
              <h1 className="text-5xl md:text-7xl font-extrabold font-sans tracking-tight leading-tight max-w-3xl mb-6">
                Music becomes more fun when the next song is a <span className="bg-gradient-to-r from-spotify-green to-emerald-400 bg-clip-text text-transparent text-glow">surprise</span>.
              </h1>
              
              <p className="text-spotify-text text-lg md:text-xl max-w-2xl mb-10 font-medium leading-relaxed">
                Host collaborative synchronized listening rooms. Invite friends, share custom room codes, and build a collaborative queue anonymously where the playlist remains hidden. Let the suspense play out!
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
                  <Compass className="w-5 h-5 text-spotify-green" /> Explore Parties
                </button>
              </div>

              {/* Grid Features */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full">
                
                <div className="glass-card p-6 rounded-2xl text-left">
                  <div className="w-12 h-12 rounded-xl bg-spotify-green/10 text-spotify-green flex items-center justify-center mb-4">
                    <Radio className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">Synchronized Playback</h3>
                  <p className="text-spotify-text text-sm leading-relaxed">
                    Experience high-fidelity synchronized playback. Audio streams directly in absolute synchronization using real-time offset synchronization so everyone shares the exact same musical moment.
                  </p>
                </div>

                <div className="glass-card p-6 rounded-2xl text-left">
                  <div className="w-12 h-12 rounded-xl bg-spotify-green/10 text-spotify-green flex items-center justify-center mb-4">
                    <Layers className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">Hidden Shared Queue</h3>
                  <p className="text-spotify-text text-sm leading-relaxed">
                    Everyone suggests songs anonymously but only the host sees what is coming next. Guests enjoy the mystery and anticipation of the next track, creating the perfect collaborative surprise.
                  </p>
                </div>

                <div className="glass-card p-6 rounded-2xl text-left">
                  <div className="w-12 h-12 rounded-xl bg-spotify-green/10 text-spotify-green flex items-center justify-center mb-4">
                    <Compass className="w-6 h-6" />
                  </div>
                  <h3 className="text-lg font-bold mb-2">Seamless Global Discovery</h3>
                  <p className="text-spotify-text text-sm leading-relaxed">
                    Establish public, private (password-protected), or unlisted rooms instantly. Connect seamlessly via sharing links, invite QR codes, or direct 5-letter room codes.
                  </p>
                </div>

              </div>

              {/* Rich SEO & AEO (AI Engine Optimization) FAQ Block */}
              <div id="specs" className="mt-20 w-full max-w-4xl border-t border-white/5 pt-12 text-left">
                <h2 className="text-xl font-bold mb-6 text-white text-center">About LocalParty • FAQ & Features</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm text-spotify-text">
                  <div className="glass-card p-5 rounded-xl border border-white/5">
                    <h3 className="font-extrabold text-white mb-2">What is LocalParty?</h3>
                    <p className="leading-relaxed">LocalParty is a real-time synchronized music queue system. It lets hosts establish collaborative online listening rooms where guests add songs anonymously, keeping the upcoming tracks hidden for an exciting social surprise listening experience.</p>
                  </div>
                  
                  <div className="glass-card p-5 rounded-xl border border-white/5">
                    <h3 className="font-extrabold text-white mb-2">How does synchronized listening work?</h3>
                    <p className="leading-relaxed">The host plays audio on their device, and everyone connected shares the exact same synchronized music moment. Guests act as remote controllers, suggesting tracks anonymously without interrupting the host's active stream.</p>
                  </div>
                  
                  <div className="glass-card p-5 rounded-xl border border-white/5">
                    <h3 className="font-extrabold text-white mb-2">Can guests control playback or skip tracks?</h3>
                    <p className="leading-relaxed">Hosts maintain total administrative control. When setting up a room, hosts can toggle granular guest permissions such as seeking, pausing/playing, skipping songs, default volume levels, or showing/hiding video renders on guest screens.</p>
                  </div>
                  
                  <div className="glass-card p-5 rounded-xl border border-white/5">
                    <h3 className="font-extrabold text-white mb-2">What is an Unlisted Room?</h3>
                    <p className="leading-relaxed">When hosting, you can toggle the "Unlisted" option. This keeps the room completely private by hiding it from the public active rooms list and search indexes. To join an unlisted room, guests must enter the 5-digit room code directly.</p>
                  </div>
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
                <p className="text-spotify-text text-sm mt-2">Set up your synchronized party room instantly</p>
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
                    placeholder="e.g. DJ Party's room"
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
                    placeholder="e.g. DJ Party"
                    value={hostName}
                    onChange={(e) => setHostName(e.target.value)}
                    className="w-full px-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-sm"
                  />
                </div>

                <div className="flex flex-col gap-3 py-1">
                  <div className="flex items-center gap-2">
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

                  <div className="flex items-center gap-2">
                    <input
                      id="is-unlisted-room"
                      type="checkbox"
                      checked={isUnlistedRoom}
                      onChange={(e) => setIsUnlistedRoom(e.target.checked)}
                      className="w-4 h-4 rounded-sm bg-spotify-light-gray/60 border-white/10 text-spotify-green focus:ring-0 focus:ring-offset-0 cursor-pointer"
                    />
                    <label htmlFor="is-unlisted-room" className="text-xs font-bold uppercase tracking-wider text-spotify-text cursor-pointer select-none text-left">
                      Unlisted Room (Hide from discovery list & search)
                    </label>
                  </div>
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

                {/* Collapsible Guest Control Permissions Settings */}
                <div className="border-t border-white/5 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowPermissionsConfig(!showPermissionsConfig)}
                    className="w-full flex items-center justify-between py-2 text-xs font-bold uppercase tracking-wider text-spotify-text hover:text-white transition cursor-pointer select-none"
                  >
                    <span>🛡️ Guest Control Permissions</span>
                    <span className="text-spotify-green font-mono">{showPermissionsConfig ? '▲' : '▼'}</span>
                  </button>

                  <AnimatePresence>
                    {showPermissionsConfig && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden mt-3 space-y-3.5 pl-1 text-left"
                      >
                        {/* 1. Skip songs */}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-spotify-text">Guests can skip songs</span>
                          <label className="relative inline-flex items-center cursor-pointer select-none">
                            <input 
                              type="checkbox" 
                              checked={allowGuestSkip} 
                              onChange={(e) => setAllowGuestSkip(e.target.checked)}
                              className="sr-only peer" 
                            />
                            <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                          </label>
                        </div>

                        {/* 2. Seek progress */}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-spotify-text">Guests can seek & rewind 10s</span>
                          <label className="relative inline-flex items-center cursor-pointer select-none">
                            <input 
                              type="checkbox" 
                              checked={allowGuestSeek} 
                              onChange={(e) => setAllowGuestSeek(e.target.checked)}
                              className="sr-only peer" 
                            />
                            <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                          </label>
                        </div>

                        {/* 3. Play/Pause */}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-spotify-text">Guests can play & pause song</span>
                          <label className="relative inline-flex items-center cursor-pointer select-none">
                            <input 
                              type="checkbox" 
                              checked={allowGuestPlayPause} 
                              onChange={(e) => setAllowGuestPlayPause(e.target.checked)}
                              className="sr-only peer" 
                            />
                            <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                          </label>
                        </div>

                        {/* 4. Mute/Unmute */}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-spotify-text">Guests start muted (prevent echoes)</span>
                          <label className="relative inline-flex items-center cursor-pointer select-none">
                            <input 
                              type="checkbox" 
                              checked={guestMuteByDefault} 
                              onChange={(e) => setGuestMuteByDefault(e.target.checked)}
                              className="sr-only peer" 
                            />
                            <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                          </label>
                        </div>

                        {/* 5. Display Video */}
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-spotify-text">Display video player on guest devices</span>
                          <label className="relative inline-flex items-center cursor-pointer select-none">
                            <input 
                              type="checkbox" 
                              checked={displayGuestVideo} 
                              onChange={(e) => setDisplayGuestVideo(e.target.checked)}
                              className="sr-only peer" 
                            />
                            <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                          </label>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
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
                      placeholder="e.g. DJ Party"
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
                      className="w-full py-3.5 rounded-xl bg-spotify-green text-black font-extrabold hover:scale-102 hover:bg-spotify-green/95 active:scale-98 transition cursor-pointer text-sm whitespace-nowrap flex-shrink-0"
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
                            if (qrScanTimeoutRef.current) {
                              clearTimeout(qrScanTimeoutRef.current);
                              qrScanTimeoutRef.current = null;
                            }
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
                        onClick={handleCancelQRScan}
                        className="mt-6 px-5 py-2.5 bg-white/5 border border-white/10 rounded-full hover:bg-white/10 text-xs font-bold transition cursor-pointer"
                      >
                        Cancel
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>



                <button
                  onClick={() => setCurrentView('landing')}
                  className="mt-6 w-full text-center text-xs font-semibold text-spotify-text hover:text-white transition flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" /> Cancel and Go Back
                </button>
              </div>

              {/* Dynamic discovery list in join room page */}
              {filteredDiscoveredRooms.length > 0 && (
                <div className="glass-panel p-6 rounded-2xl border border-white/5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-spotify-text mb-4">
                    Active Public Listening Parties
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

          {/* VIEW: ROOM DISCOVERY */}
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
                  <p className="text-spotify-text text-sm mt-1">Explore and join active global listening parties</p>
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
              <div className="relative mb-4">
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
                      : "Make sure an admin has created a room."}
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
                    <ShieldAlert className="w-5 h-5 text-red-400" />
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
                    <div className="flex items-center gap-3 flex-wrap">
                      <h2 className="text-2xl font-extrabold leading-tight">{roomName}</h2>
                    </div>
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
                    <div 
                      className={`transition-all duration-300 ${
                        (userRole === 'host' || roomPermissions?.displayGuestVideo) && currentSong 
                          ? 'w-full h-full opacity-100' 
                          : 'absolute w-[1px] h-[1px] opacity-0 pointer-events-none'
                      }`}
                    >
                      <YouTubePlaceholder />
                    </div>
                    
                    {/* Visualizer and Vinyl Cover Art if guest video is off or no song */}
                    {(!(userRole === 'host' || roomPermissions?.displayGuestVideo) || !currentSong) && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-gradient-to-br from-spotify-dark via-spotify-gray to-spotify-black text-center w-full h-full">
                        {currentSong ? (
                          <>
                            {/* Spinning Vinyl Record / Cover Art */}
                            <div className="relative w-28 h-28 mb-3 flex items-center justify-center">
                              <div 
                                className={`w-full h-full rounded-full border-4 border-spotify-light-gray shadow-2xl overflow-hidden ${
                                  isPlaying ? 'animate-spin-slow' : ''
                                }`}
                                style={{ 
                                  backgroundImage: `url(${currentSong.albumArt})`, 
                                  backgroundSize: 'cover',
                                  backgroundPosition: 'center'
                                }}
                              >
                                {/* Center spindle hole */}
                                <div className="absolute inset-0 m-auto w-6 h-6 rounded-full bg-spotify-black border border-white/20 shadow-inner flex items-center justify-center">
                                  <div className="w-1.5 h-1.5 rounded-full bg-spotify-green"></div>
                                </div>
                              </div>
                            </div>

                            {/* Audio Visualizer Waves */}
                            <div className="flex items-end justify-center gap-1 h-6 mt-1">
                              {Array.from({ length: 15 }).map((_, i) => {
                                const animDuration = [0.8, 1.2, 0.6, 1.5, 0.9, 1.1, 0.7, 1.3, 1.0, 1.4, 0.8, 1.2, 0.5, 1.1, 0.9][i];
                                return (
                                  <div
                                    key={i}
                                    className="w-1 bg-spotify-green rounded-full transition-all duration-300"
                                    style={{
                                      height: isPlaying ? '100%' : '15%',
                                      animation: isPlaying ? `visualizer-bounce ${animDuration}s ease-in-out infinite alternate` : 'none',
                                      animationDelay: `${i * 0.05}s`
                                    }}
                                  />
                                );
                              })}
                            </div>
                          </>
                        ) : (
                          <div className="flex flex-col items-center justify-center text-spotify-text">
                            <Music className="w-12 h-12 mb-2 stroke-[1.5] text-spotify-text/30 animate-pulse" />
                            <p className="text-xs">No active video stream</p>
                          </div>
                        )}
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
                      disabled={!currentSong || (userRole !== 'host' && !roomPermissions?.allowGuestSeek)}
                      className={`w-full h-1 bg-white/10 rounded-full appearance-none accent-spotify-green focus:outline-hidden ${
                        (userRole === 'host' || roomPermissions?.allowGuestSeek) ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'
                      }`}
                      style={{
                        background: `linear-gradient(to right, #1db954 0%, #1db954 ${currentSong ? (playbackProgress / currentSong.duration) * 100 : 0}%, rgba(255,255,255,0.1) ${currentSong ? (playbackProgress / currentSong.duration) * 100 : 0}%, rgba(255,255,255,0.1) 100%)`
                      }}
                      title={!(userRole === 'host' || roomPermissions?.allowGuestSeek) ? 'Only permitted users can seek global playback' : 'Seek playback position'}
                    />
                    <div className="flex justify-between text-xxs font-bold text-spotify-text tracking-wide font-mono">
                      <span>{formatTime(playbackProgress)}</span>
                      <span>{formatTime(currentSong ? currentSong.duration : 0)}</span>
                    </div>
                  </div>

                  {/* Controller Playback Panel */}
                  <div className="w-full flex items-center justify-center gap-4 mt-8 flex-wrap">
                    {/* Mute output button */}
                    <button
                      onClick={() => setIsMuted(!isMuted)}
                      className={`p-2.5 rounded-full transition border cursor-pointer ${
                        isMuted 
                          ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20' 
                          : 'bg-white/5 border-white/5 text-spotify-text hover:text-white hover:bg-white/10'
                      }`}
                      title={userRole === 'host' ? (isMuted ? 'Unmute host device' : 'Mute host device') : (isMuted ? 'Unmute local player' : 'Mute local player')}
                    >
                      {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </button>

                    {/* Seek Backward 10s */}
                    <button
                      onClick={() => handleSeekOffset(-10)}
                      disabled={!currentSong || (userRole !== 'host' && !roomPermissions?.allowGuestSeek)}
                      className={`px-3 py-2 rounded-full transition border font-mono text-xs font-bold ${
                        (currentSong && (userRole === 'host' || roomPermissions?.allowGuestSeek))
                          ? 'bg-white/5 border-white/5 text-spotify-text hover:text-white hover:bg-white/10 cursor-pointer' 
                          : 'border-white/5 text-white/10 cursor-not-allowed'
                      }`}
                      title={!(userRole === 'host' || roomPermissions?.allowGuestSeek) ? 'Only permitted users can seek global playback' : 'Seek backward 10 seconds'}
                    >
                      -10s
                    </button>

                    {/* Play/Pause Button */}
                    <button
                      onClick={() => handlePlayPause()}
                      disabled={!currentSong || (userRole !== 'host' && !roomPermissions?.allowGuestPlayPause)}
                      className={`w-14 h-14 rounded-full flex items-center justify-center transition shadow-lg ${
                        (currentSong && (userRole === 'host' || roomPermissions?.allowGuestPlayPause))
                          ? 'bg-white text-black hover:scale-105 hover:bg-spotify-green hover:shadow-[0_0_20px_#1db954] cursor-pointer' 
                          : 'bg-white/10 text-white/20 cursor-not-allowed'
                      }`}
                      title={!(userRole === 'host' || roomPermissions?.allowGuestPlayPause) ? 'Only permitted users can pause/play global playback' : (currentSong ? (isPlaying ? 'Pause song' : 'Play song') : 'No song playing')}
                    >
                      {isPlaying ? <Pause className="w-6 h-6 fill-current stroke-[3]" /> : <Play className="w-6 h-6 fill-current stroke-[3] translate-x-0.5" />}
                    </button>

                    {/* Seek Forward 10s */}
                    <button
                      onClick={() => handleSeekOffset(10)}
                      disabled={!currentSong || (userRole !== 'host' && !roomPermissions?.allowGuestSeek)}
                      className={`px-3 py-2 rounded-full transition border font-mono text-xs font-bold ${
                        (currentSong && (userRole === 'host' || roomPermissions?.allowGuestSeek))
                          ? 'bg-white/5 border-white/5 text-spotify-text hover:text-white hover:bg-white/10 cursor-pointer' 
                          : 'border-white/5 text-white/10 cursor-not-allowed'
                      }`}
                      title={!(userRole === 'host' || roomPermissions?.allowGuestSeek) ? 'Only permitted users can seek global playback' : 'Seek forward 10 seconds'}
                    >
                      +10s
                    </button>

                    {/* Skip button (Visible for host, or guest if allowGuestSkip is true) */}
                    {(userRole === 'host' || roomPermissions?.allowGuestSkip) && (
                      <button
                        onClick={handleSkip}
                        disabled={!currentSong && hostQueue.length === 0}
                        className={`p-3 rounded-full border transition ${
                          (currentSong || hostQueue.length > 0)
                            ? 'bg-white/5 border-white/5 text-white hover:bg-white/10 hover:border-white/10 cursor-pointer'
                            : 'border-white/5 text-white/20 cursor-not-allowed'
                        }`}
                        title="Skip to next song"
                      >
                        <SkipForward className="w-5 h-5 fill-current" />
                      </button>
                    )}

                    {/* Suggest button (Visible for guests) */}
                    {userRole === 'guest' && (
                      <button
                        onClick={() => setIsSearchOpen(true)}
                        className="px-5 py-2.5 rounded-full bg-spotify-green text-black font-extrabold flex items-center justify-center gap-1.5 hover:scale-105 active:scale-95 transition shadow-lg cursor-pointer text-xs whitespace-nowrap flex-shrink-0"
                      >
                        <Plus className="w-4 h-4 stroke-[3]" /> Suggest
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Right Column: Active users & Host Queue Drawer OR Guest Recently Played */}
              <div className="lg:col-span-5 flex flex-col gap-6 w-full">
                
                {/* Host Dynamic Settings and Permissions Panel */}
                {userRole === 'host' && (
                  <div className="glass-panel p-6 rounded-2xl border border-white/5 w-full text-left">
                    <button
                      type="button"
                      onClick={() => setShowPermissionsConfig(!showPermissionsConfig)}
                      className="w-full flex items-center justify-between text-xs font-bold uppercase tracking-wider text-spotify-text hover:text-white transition cursor-pointer select-none whitespace-nowrap flex-shrink-0"
                    >
                      <span className="flex items-center gap-2">
                        <ShieldAlert className="w-4 h-4 text-spotify-green animate-pulse" />
                        Room Settings & Permissions
                      </span>
                      <span className="text-spotify-green font-mono">{showPermissionsConfig ? '▲' : '▼'}</span>
                    </button>

                    <AnimatePresence>
                      {showPermissionsConfig && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="overflow-hidden mt-4 space-y-4 border-t border-white/5 pt-4 pl-1"
                        >
                          {/* 1. Skip songs */}
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-spotify-text">Allow guests to skip songs</span>
                            <label className="relative inline-flex items-center cursor-pointer select-none">
                              <input 
                                type="checkbox" 
                                checked={roomPermissions?.allowGuestSkip ?? true} 
                                onChange={(e) => updateSinglePermission('allowGuestSkip', e.target.checked)}
                                className="sr-only peer" 
                              />
                              <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                            </label>
                          </div>

                          {/* 2. Seek progress */}
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-spotify-text">Allow guests to seek & rewind 10s</span>
                            <label className="relative inline-flex items-center cursor-pointer select-none">
                              <input 
                                type="checkbox" 
                                checked={roomPermissions?.allowGuestSeek ?? false} 
                                onChange={(e) => updateSinglePermission('allowGuestSeek', e.target.checked)}
                                className="sr-only peer" 
                              />
                              <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                            </label>
                          </div>

                          {/* 3. Play/Pause */}
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-spotify-text">Allow guests to play & pause song</span>
                            <label className="relative inline-flex items-center cursor-pointer select-none">
                              <input 
                                type="checkbox" 
                                checked={roomPermissions?.allowGuestPlayPause ?? true} 
                                onChange={(e) => updateSinglePermission('allowGuestPlayPause', e.target.checked)}
                                className="sr-only peer" 
                              />
                              <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                            </label>
                          </div>

                          {/* 4. Display Video */}
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-spotify-text">Display video player on guest devices</span>
                            <label className="relative inline-flex items-center cursor-pointer select-none">
                              <input 
                                type="checkbox" 
                                checked={roomPermissions?.displayGuestVideo ?? false} 
                                onChange={(e) => updateSinglePermission('displayGuestVideo', e.target.checked)}
                                className="sr-only peer" 
                              />
                              <div className="relative w-9 h-5 bg-white/10 rounded-full peer-focus:ring-0 peer-checked:after:translate-x-4 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-spotify-green"></div>
                            </label>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
                
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
                        className="px-2.5 py-1 rounded-full bg-white/5 border border-white/5 text-xxs font-bold text-white hover:bg-white/10 hover:border-white/10 transition flex items-center gap-1 cursor-pointer whitespace-nowrap flex-shrink-0"
                      >
                        <Plus className="w-3.5 h-3.5" /> Add Track
                      </button>
                    </div>
                    <div className="flex-grow overflow-y-auto custom-scrollbar pr-1 space-y-3">
                      {hostQueue.length === 0 ? (
                        autoplayQueue.length > 0 ? (
                          <div className="space-y-3 text-left">
                            <div className="flex flex-col items-center justify-center py-4 text-center text-spotify-text border-b border-white/5 pb-4 mb-2">
                              <Layers className="w-8 h-8 mb-2 stroke-[1.5] text-spotify-text/30" />
                              <p className="text-xs font-semibold text-white/80">Active Queue is empty</p>
                              <p className="text-[10px] text-spotify-text mt-0.5 px-2">Guests have not suggested any tracks yet. Playing from prospective list:</p>
                            </div>
                            
                            <h4 className="text-[10px] font-extrabold uppercase tracking-wider text-spotify-green/80 mb-2 pl-2">Up Next (Autoplay)</h4>
                            {autoplayQueue.map((song, idx) => (
                              <div 
                                key={song.id || idx}
                                className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition opacity-80 hover:opacity-100"
                              >
                                <img 
                                  src={song.albumArt} 
                                  alt={song.album} 
                                  className="w-10 h-10 rounded-md object-cover border border-white/5 filter grayscale-[30%]"
                                />
                                <div className="flex-1 min-w-0">
                                  <h4 className="text-xs font-bold text-white/80 truncate">{song.title}</h4>
                                  <p className="text-xxs text-spotify-text truncate mt-0.5">
                                    {song.artist} • <span className="text-spotify-green">Autoplay Candidate</span>
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center h-full py-8 text-center text-spotify-text">
                            <Layers className="w-10 h-10 mb-3 stroke-[1.5] text-spotify-text/30" />
                            <p className="text-xs font-semibold">Queue is empty</p>
                            <p className="text-xxs mt-1">Guests can add songs anytime!</p>
                          </div>
                        )
                      ) : (
                        hostQueue.map((song, index) => (
                          <div 
                            key={song.id}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData("text/plain", index.toString());
                            }}
                            onDragOver={(e) => {
                              e.preventDefault();
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              const sourceIdx = parseInt(e.dataTransfer.getData("text/plain"), 10);
                              const targetIdx = index;
                              if (sourceIdx === targetIdx) return;
                              
                              const newQueue = [...hostQueue];
                              const popped = newQueue.splice(sourceIdx, 1)[0];
                              newQueue.splice(targetIdx, 0, popped);
                              handleReorderQueue(newQueue);
                            }}
                            className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group cursor-grab active:cursor-grabbing border border-transparent hover:border-white/5 select-none"
                          >
                            <img 
                              src={song.albumArt} 
                              alt={song.album} 
                              className="w-10 h-10 rounded-md object-cover border border-white/5"
                            />
                            <div className="flex-1 min-w-0 text-left">
                              <h4 className="text-xs font-bold text-white truncate">{song.title}</h4>
                              <p className="text-xxs text-spotify-text truncate mt-0.5">
                                {song.artist} • By {song.addedBy}
                              </p>
                            </div>
                            
                            {/* Priority / Move Control Buttons */}
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity focus-within:opacity-100 flex-shrink-0">
                              {index > 0 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); moveSongToTop(index); }}
                                  className="p-1 hover:bg-white/10 rounded text-spotify-green hover:text-green-400 transition cursor-pointer"
                                  title="Move to top of playlist"
                                >
                                  <Upload className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {index > 0 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); moveSongUp(index); }}
                                  className="p-1 hover:bg-white/10 rounded text-spotify-text hover:text-white transition cursor-pointer"
                                  title="Move up"
                                >
                                  <ArrowUp className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {index < hostQueue.length - 1 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); moveSongDown(index); }}
                                  className="p-1 hover:bg-white/10 rounded text-spotify-text hover:text-white transition cursor-pointer"
                                  title="Move down"
                                >
                                  <ArrowDown className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>

                            <button
                              onClick={() => handleRemoveFromQueue(song.id)}
                              className="p-1.5 rounded-full hover:bg-red-500/10 text-spotify-text hover:text-red-400 transition opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer flex-shrink-0"
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

      {/* Right Sidebar Ad Slot - Hidden (will work on it later) */}
      <div className="hidden w-[200px] flex-shrink-0 flex-col gap-4 py-8">
        <div className="glass-panel p-4 rounded-2xl border border-white/5 h-[600px] sticky top-[100px] flex flex-col items-center justify-center text-center text-spotify-text text-xxs font-bold uppercase tracking-wider">
          <span className="text-white/20 mb-3 block">Sponsored Ad</span>
          <div className="flex-grow w-full bg-white/2 rounded-xl border border-white/5 flex flex-col items-center justify-center p-4">
            <span className="text-white/10 font-bold mb-1">Zero Latency</span>
            <span className="text-white/5 font-semibold text-[10px] normal-case text-center">Host collaborative music rooms globally</span>
          </div>
        </div>
      </div>
    </div>

      {/* Global Bottom sticky banner for music discovery when not in player */}
      {currentView === 'landing' && discoveredRooms.length > 0 && (
        <div className="w-full bg-spotify-green/95 text-black py-2.5 px-6 font-semibold text-center text-xs flex justify-center items-center gap-3 z-20 cursor-pointer hover:bg-spotify-green transition-all"
             onClick={() => setCurrentView('discovery')}>
          <Compass className="w-4 h-4 animate-spin" style={{ animationDuration: '8s' }} />
          <span>{discoveredRooms.length} active party room{discoveredRooms.length > 1 ? 's' : ''} detected! Tap to discover.</span>
        </div>
      )}

      {/* Redesigned Larger than Life Modern Footer */}
      <footer className="w-full border-t border-white/5 bg-spotify-black/80 backdrop-blur-xl pt-16 pb-12 z-10 mt-auto">
        <div className="max-w-6xl mx-auto px-6 grid grid-cols-1 md:grid-cols-12 gap-10 mb-12">
          {/* Brand Identity Column */}
          <div className="md:col-span-6 flex flex-col items-start text-left">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-2.5 h-2.5 rounded-full bg-spotify-green animate-pulse shadow-[0_0_10px_#1db954]"></span>
              <span className="text-xl font-black tracking-widest text-white uppercase font-sans">LocalParty</span>
            </div>
            <p className="text-spotify-text text-sm max-w-sm leading-relaxed mb-6 font-medium">
              The ultimate collaborative social music queue system. Stream synchronized audio in absolute real-time while keeping the upcoming surprise playlist beautifully hidden from your guests.
            </p>
          </div>

          {/* Column 2: Features */}
          <div className="md:col-span-3 flex flex-col items-start text-left">
            <h4 className="text-xs font-bold uppercase tracking-widest text-white mb-4">Features</h4>
            <ul className="space-y-2.5 text-xs font-semibold text-spotify-text">
              <li className="hover:text-white transition cursor-default">Surprise Playlist Queue</li>
              <li className="hover:text-white transition cursor-default">Anonymous Track Suggestions</li>
              <li className="hover:text-white transition cursor-default">Granular Administrative Controls</li>
              <li className="hover:text-white transition cursor-default">Private Unlisted Room Security</li>
            </ul>
          </div>

          {/* Column 3: Explore */}
          <div className="md:col-span-3 flex flex-col items-start text-left">
            <h4 className="text-xs font-bold uppercase tracking-widest text-white mb-4">Explore</h4>
            <ul className="space-y-2.5 text-xs font-semibold text-spotify-text">
              <li><button onClick={() => setCurrentView('landing')} className="hover:text-spotify-green hover:underline cursor-pointer transition text-left">Host Party</button></li>
              <li><button onClick={() => setCurrentView('join-room')} className="hover:text-spotify-green hover:underline cursor-pointer transition text-left">Join Session</button></li>
              <li><button onClick={() => setCurrentView('discovery')} className="hover:text-spotify-green hover:underline cursor-pointer transition text-left">Public Discovery</button></li>
              <li><a href="#specs" onClick={() => { setCurrentView('landing'); setTimeout(() => document.getElementById('specs')?.scrollIntoView({ behavior: 'smooth' }), 105); }} className="hover:text-spotify-green hover:underline cursor-pointer transition text-left">Technical Specs</a></li>
              <li><button onClick={() => setIsFeedbackOpen(true)} className="text-spotify-green font-extrabold hover:text-spotify-green hover:underline cursor-pointer transition text-left">Give Feedback</button></li>
            </ul>
          </div>
        </div>

        {/* Separator & Bottom Row */}
        <div className="max-w-6xl mx-auto px-6 border-t border-white/5 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xxs tracking-widest text-spotify-text/60 font-semibold uppercase">
          <div>
            <span>LocalParty &copy; {new Date().getFullYear()} • All rights reserved.</span>
          </div>
          <div className="flex items-center gap-1.5 hover:text-white transition-colors duration-300">
            <span>Developed by</span>
            <span className="text-white font-extrabold tracking-wide hover:text-spotify-green transition-colors duration-300 cursor-pointer">
              Developers of Emerging Coders
            </span>
          </div>
        </div>
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
        localIp={hostLocalIp || clientSystemIp}
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

      <FeedbackModal
        isOpen={isFeedbackOpen}
        onClose={() => setIsFeedbackOpen(false)}
        backendHost={backendHost}
      />

    </div>
  );
}

export default App;
