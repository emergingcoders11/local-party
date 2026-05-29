import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import os from "os";
import yts from "yt-search";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

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

// ============================================================================
// SMART MUSIC RECOMMENDATION ENGINE
// Spotify/YouTube Music-style autoplay optimized for Bollywood & Punjabi music
// ============================================================================

// --- Title Normalization ---
// Aggressively strips junk keywords from YouTube titles to extract the pure song name.
const JUNK_KEYWORDS = [
  'official', 'video', 'audio', 'full', 'song', 'music', 'hd', '4k', '1080p', '720p',
  'lyric', 'lyrics', 'lyrical', 'remix', 'remixed', 'dj', 'slowed', 'reverb', 'lofi',
  'teaser', 'trailer', 'promo', 'preview', 'shorts', 'short', 'clip', 'clips',
  'status', 'whatsapp', 'fan', 'made', 'edit', 'fanmade', 'fanedit',
  'reaction', 'react', 'review', 'cover', 'unplugged', 'acoustic', 'karaoke',
  'instrumental', 'bass', 'boosted', 'bassboosted', 'extended', 'mashup', 'mash',
  'ringtone', 'bgm', 'ost', 'soundtrack', 'repost', 'reupload', 'upload',
  'new', 'latest', 'best', 'top', 'hit', 'super', 'mega',
  'feat', 'ft', 'featuring', 'presents', 'records', 'production', 'productions',
  'motion', 'picture', 'pictures', 'films', 'film', 'movie',
  'exclusive', 'premiere', 'released', 'out', 'now',
  'punjabi', 'hindi', 'bollywood', 'latest',
  'live', 'performance', 'concert', 'stage', 'show',
  'remastered', 'version', 'original', 'special', 'deluxe',
];
const JUNK_REGEX = new RegExp(`\\b(${JUNK_KEYWORDS.join('|')})\\b`, 'gi');

function normalizeTitle(title) {
  if (!title) return '';
  let norm = title.toLowerCase();
  // Remove content inside parentheses, brackets, pipes
  norm = norm.replace(/\([^)]*\)/g, ' ');
  norm = norm.replace(/\[[^\]]*\]/g, ' ');
  norm = norm.replace(/\{[^}]*\}/g, ' ');
  // Remove everything after a pipe character
  norm = norm.replace(/\|.*$/, ' ');
  // Remove junk keywords
  norm = norm.replace(JUNK_REGEX, ' ');
  // Remove special characters except spaces and alphanumeric
  norm = norm.replace(/[^a-z0-9\s]/g, ' ');
  // Remove "x" used as "feat" separator (e.g. "Singer1 x Singer2")
  norm = norm.replace(/\bx\b/g, ' ');
  // Collapse whitespace
  norm = norm.replace(/\s+/g, ' ').trim();
  return norm;
}

// --- Singer Name Extraction ---
// YouTube titles often follow patterns like "Song Name - Artist Name" or "Song Name | Artist Name"
// The channel `author.name` is often a label like "T-Series" — not the actual singer.
// This function tries to extract the actual singer name from the title.
function extractSingerFromTitle(rawTitle) {
  if (!rawTitle) return '';
  // Common separators: " - ", " | ", " – ", " — ", " : "
  const separators = [' - ', ' – ', ' — ', ' | ', ' : '];
  for (const sep of separators) {
    const idx = rawTitle.indexOf(sep);
    if (idx !== -1) {
      const afterSep = rawTitle.substring(idx + sep.length).trim();
      // Clean the singer part — remove junk like "(Official Video)"
      let singer = afterSep
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/official|video|audio|lyric|lyrics|ft\.?|feat\.?|music/gi, '')
        .replace(/[^a-zA-Z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // If the extracted part is reasonable (2-40 chars), use it
      if (singer.length >= 2 && singer.length <= 40) {
        return singer.toLowerCase();
      }
    }
  }
  return '';
}

// --- Bad Video Type Detection ---
// Returns true if the video title/channel indicates it's NOT a proper music track.
function isBadVideoType(title, channelName) {
  const lower = (title || '').toLowerCase();
  const channel = (channelName || '').toLowerCase();
  const badPatterns = [
    /\bteaser\b/, /\btrailer\b/, /\bpromo\b/, /\bpreview\b/,
    /\breaction\b/, /\breact\b/, /\breview\b/, /\bunboxing\b/,
    /\bshorts?\b/, /\bclips?\b/, /\bstatus\b/, /\bwhatsapp\b/,
    /\bringtone\b/, /\bbgm\b/, /\bkaraoke\b/, /\binstrumental\b/,
    /\bfan\s*made\b/, /\bfan\s*edit\b/, /\bfan\s*version\b/,
    /\bbehind\s*the\s*scenes?\b/, /\bmaking\s*of\b/,
    /\bparody\b/, /\bcomedy\b/, /\bfunny\b/, /\broast\b/,
    /\bmashup\b/, /\bmash\s*up\b/,
    /\bbass\s*boosted\b/, /\bbass\s*boost\b/,
    /\b8\s*d\s*audio\b/, /\b16\s*d\b/,
    /\bslowed\b.*\breverb\b/, /\breverb\b.*\bslowed\b/,
    /\bslowed\b/, /\breverb\b/, /\blofi\b/, /\blo\s*fi\b/,
    /\bsped\s*up\b/, /\bspeed\s*up\b/, /\bnightcore\b/,
    /\bdj\s*remix\b/, /\bdj\s*mix\b/,
    /\bremix\b/, /\bremixed\b/, /\brefix\b/,
    /\bcover\b/, /\bacoustic\b/, /\bunplugged\b/,
    /\blive\s*performance\b/, /\bconcert\b/, /\bstage\s*show\b/,
    /\blyric(s|al)?\b/,
    // Beat/instrumental tracks
    /\btype\s*beat\b/, /\bbeat\s*only\b/, /\bno\s*vocal\b/,
    // Compilation/blockbuster multi-song videos
    /\bjukebox\b/, /\bnon\s*stop\b/, /\bjukebox\b/, /\btop\s*\d+\b/,
    /\bcollection\b/, /\bcompilation\b/,
  ];
  if (badPatterns.some(pattern => pattern.test(lower))) return true;

  // Block regional language sub-channels
  const regionalChannelPatterns = [
    /telugu/, /tamil/, /kannada/, /malayalam/, /bengali/, /odia/, /marathi/,
  ];
  if (regionalChannelPatterns.some(p => p.test(channel))) return true;

  return false;
}

// --- Language / Region Filter ---
// Returns true if a video appears to be from a non Hindi/Punjabi language.
function isWrongLanguage(title, channelName) {
  const lower = (title || '').toLowerCase();
  const channel = (channelName || '').toLowerCase();

  // Block strong regional-language keywords found in titles
  const regionalTitleKeywords = [
    /\btelugu\b/, /\btamil\b/, /\bkannada\b/, /\bmalayalam\b/,
    /\bodia\b/, /\bbhojpuri\b/, /\bmarathi\b/, /\bgujarati\b/,
    /\bsarrainodu\b/, /\ballu\s*arjun\b/, /\bprabhas\b/, /\bmahesh\b/,
    /\bntr\b/, /\bramcharan\b/, /\byash\b/, /\bdhanush\b/,
    /\bvijay\b/, /\bajith\b/, /\bsimbu\b/, /\bkollywood\b/,
    /\btollywood\b/, /\bsandalwood\b/, /\bmollywood\b/,
  ];
  if (regionalTitleKeywords.some(p => p.test(lower))) return true;

  // Block regional channels
  const regionalChannels = [
    /t-series\s*telugu/, /t-series\s*tamil/, /t-series\s*kannada/,
    /t-series\s*regional/, /t-series\s*marathi/, /t-series\s*gujarati/,
    /aditya\s*music/, /lahari\s*music/, /sony\s*music\s*south/,
    /sun\s*tv/, /star\s*vijay/, /zee\s*telugu/, /zee\s*tamil/,
    /aha\s*video/, /aha\s*music/,
  ];
  if (regionalChannels.some(p => p.test(channel))) return true;

  return false;
}

// --- Semantic Duplicate Detection ---
// Returns true if two normalized titles refer to the same song.
// Uses word overlap to catch "Blue Eyes" vs "Blue Eyes Official Video HD" etc.
function isDuplicateSong(normalizedCurrent, normalizedCandidate, currentSingerWords) {
  if (!normalizedCurrent || !normalizedCandidate) return false;

  const currentWords = normalizedCurrent.split(' ').filter(w => w.length > 1);
  const candidateWords = normalizedCandidate.split(' ').filter(w => w.length > 1);

  if (currentWords.length === 0 || candidateWords.length === 0) return false;

  // Remove singer name words from both to isolate the song name
  const currentSongWords = currentWords.filter(w => !currentSingerWords.includes(w));
  const candidateSongWords = candidateWords.filter(w => !currentSingerWords.includes(w));

  // If after removing singer words, both have 0 unique words, it's ambiguous — don't flag
  if (currentSongWords.length === 0 && candidateSongWords.length === 0) return false;

  // Check overlap: if ALL significant words of the current song appear in the candidate, it's a duplicate
  if (currentSongWords.length > 0) {
    const matchCount = currentSongWords.filter(w => candidateSongWords.includes(w)).length;
    const overlapRatio = matchCount / currentSongWords.length;
    // If 80%+ of the current song's words are found in the candidate, it's the same song
    if (overlapRatio >= 0.8) return true;
  }

  // Also check if candidate song words are a subset of current (catches shorter variants)
  if (candidateSongWords.length > 0 && currentSongWords.length > 0) {
    const reverseMatch = candidateSongWords.filter(w => currentSongWords.includes(w)).length;
    const reverseRatio = reverseMatch / candidateSongWords.length;
    if (reverseRatio >= 0.8) return true;
  }

  // Exact normalized match
  if (normalizedCurrent === normalizedCandidate) return true;

  return false;
}

// --- Multi-Factor Scoring System ---
// Scores a candidate video for recommendation quality.
function scoreCandidate(video, singerName, currentSingerWords, fromArtistSearch) {
  let score = 0;
  const vTitle = (video.title || '').toLowerCase();
  const vChannel = ((video.author && video.author.name) || '').toLowerCase();
  const views = video.views || 0;

  // PRIORITY 1: Same singer (massive bonus)
  // Check if the singer name appears in the video title or channel
  if (singerName) {
    const singerInTitle = currentSingerWords.some(w => w.length > 2 && vTitle.includes(w));
    const singerInChannel = currentSingerWords.some(w => w.length > 2 && vChannel.includes(w));
    if (singerInTitle || singerInChannel) {
      score += 500;
    }
  }

  // Bonus for coming from the artist-specific search query
  if (fromArtistSearch) {
    score += 200;
  }

  // PRIORITY 2: View count (popularity = quality signal)
  // Normalize: 100M+ views = 100 points, scaling logarithmically
  if (views > 0) {
    score += Math.min(100, Math.floor(Math.log10(views + 1) * 12));
  }

  // PRIORITY 3: Known major Bollywood/Punjabi labels (quality signal)
  const trustedLabels = ['t-series', 'speed records', 'zee music', 'tips', 'yrf', 'sony music india', 'desi melodies', 'geet mp3', 'jjust music', 'white hill music', 'anand audio'];
  if (trustedLabels.some(label => vChannel.includes(label))) {
    score += 50;
  }

  // PENALTY: Duration too short or too long (unusual for a song)
  const dur = video.seconds || 0;
  if (dur < 120 || dur > 480) {
    score -= 50;
  }

  // PENALTY: Title contains bad keywords indicating low quality
  const penaltyWords = ['remix', 'slowed', 'reverb', 'cover', 'karaoke', 'instrumental', 'mashup', '8d', 'lofi', 'nightcore'];
  for (const pw of penaltyWords) {
    if (vTitle.includes(pw)) {
      score -= 100;
    }
  }

  return score;
}

// --- Known Artist Database ---
// Full list of known Bollywood/Punjabi artists for direct name detection in titles.
// This is critical when the YouTube channel is a label (T-Series, Speed Records, etc.)
const KNOWN_ARTISTS = [
  'yo yo honey singh', 'honey singh',
  'badshah', 'raftaar', 'ikka', 'divine', 'mc stan', 'emiway bantai', 'king', 'kr$na', 'seedhe maut',
  'guru randhawa', 'harrdy sandhu', 'hardy sandhu', 'jassi gill', 'jassie gill',
  'ap dhillon', 'karan aujla', 'diljit dosanjh', 'sidhu moose wala', 'ammy virk', 'shubh', 'b praak', 'jaani',
  'arijit singh', 'jubin nautiyal', 'atif aslam', 'armaan malik', 'darshan raval', 'vishal mishra',
  'stebin ben', 'rahat fateh ali khan', 'udit narayan', 'kumar sanu',
  'neha kakkar', 'tony kakkar', 'shreya ghoshal', 'sunidhi chauhan', 'palak muchhal',
  'dhvani bhanushali', 'tulsi kumar', 'monali thakur', 'kanika kapoor',
  'nucleya', 'tanveer evan', 'mika singh', 'yo yo honey singh',
];

// --- Smart Query Builder ---
// Builds multiple search queries to maximize coverage of same-artist + related-artist + same-vibe songs.
function buildSmartQueries(rawTitle, rawArtist) {
  const normalizedCurrent = normalizeTitle(rawTitle);
  const rawTitleLower = rawTitle.toLowerCase();
  const extractedSinger = extractSingerFromTitle(rawTitle);
  const safeArtist = (rawArtist && rawArtist !== 'Unknown Artist' && rawArtist.toLowerCase() !== 'autoplay artist') ? rawArtist : '';

  // Determine the best singer name to use
  // YouTube often returns label names (T-Series, Zee Music) as artist — prefer extracted singer from title
  const knownLabels = [
    't-series', 'tseries', 't series', 'speed records', 'zee music', 'tips official',
    'yrf', 'sony music', 'desi melodies', 'geet mp3', 'white hill', 'jjust music',
    'anand audio', 'saregama', 'eros now', 'shemaroo', 'ultra bollywood', 'venus',
    'pen movies', 'pen studios', 'aditya music', 'lahari music', 'sun music',
  ];
  const artistIsLabel = knownLabels.some(label => safeArtist.toLowerCase().includes(label));

  let singerName = '';

  // Priority 1: Try to extract singer from title separator pattern ("Song - Singer")
  if (extractedSinger && extractedSinger.length > 2) {
    singerName = extractedSinger;
  }
  // Priority 2: If the reported artist is NOT a label, use it
  else if (safeArtist && !artistIsLabel) {
    singerName = safeArtist.toLowerCase();
  }

  // Priority 3 (KEY FIX): Scan the raw title for known artist names directly.
  // This handles titles like "Blue Eyes Full Video Song Yo Yo Honey Singh | T-Series"
  // where T-Series is the channel but Yo Yo Honey Singh appears in the title text.
  if (!singerName || singerName.length < 2) {
    for (const knownArtist of KNOWN_ARTISTS) {
      if (rawTitleLower.includes(knownArtist)) {
        singerName = knownArtist;
        console.log(`[Singer Detection] Found "${singerName}" in title text: "${rawTitle}"`);
        break;
      }
    }
  }

  // Map of known Bollywood/Punjabi artists → related artists for better recommendations
  const RELATED_ARTISTS_MAP = {
    'yo yo honey singh': ['badshah', 'raftaar', 'ikka', 'guru randhawa', 'diljit dosanjh'],
    'honey singh':       ['badshah', 'raftaar', 'ikka', 'guru randhawa', 'diljit dosanjh'],
    'badshah':           ['yo yo honey singh', 'raftaar', 'guru randhawa', 'divine', 'king'],
    'raftaar':           ['yo yo honey singh', 'badshah', 'divine', 'ikka'],
    'guru randhawa':     ['harrdy sandhu', 'ap dhillon', 'jassie gill', 'badshah', 'b praak'],
    'ap dhillon':        ['karan aujla', 'diljit dosanjh', 'guru randhawa', 'sidhu moose wala', 'shubh'],
    'karan aujla':       ['ap dhillon', 'sidhu moose wala', 'diljit dosanjh', 'ammy virk', 'jassie gill'],
    'diljit dosanjh':    ['ap dhillon', 'guru randhawa', 'ammy virk', 'jassie gill', 'harrdy sandhu'],
    'arijit singh':      ['jubin nautiyal', 'atif aslam', 'armaan malik', 'b praak', 'darshan raval'],
    'jubin nautiyal':    ['arijit singh', 'b praak', 'darshan raval', 'stebin ben', 'vishal mishra'],
    'neha kakkar':       ['tony kakkar', 'dhvani bhanushali', 'tulsi kumar', 'shreya ghoshal', 'sunidhi chauhan'],
    'divine':            ['raftaar', 'badshah', 'emiway bantai', 'mc stan'],
    'sidhu moose wala':  ['ap dhillon', 'karan aujla', 'diljit dosanjh', 'ammy virk', 'shubh'],
    'atif aslam':        ['arijit singh', 'rahat fateh ali khan', 'armaan malik', 'darshan raval', 'jubin nautiyal'],
    'shreya ghoshal':    ['sunidhi chauhan', 'neha kakkar', 'palak muchhal', 'monali thakur', 'arijit singh'],
    'b praak':           ['jaani', 'ammy virk', 'jubin nautiyal', 'arijit singh', 'darshan raval'],
    'king':              ['badshah', 'raftaar', 'divine', 'mc stan'],
    'mc stan':           ['divine', 'emiway bantai', 'king', 'raftaar'],
    'shubh':             ['ap dhillon', 'sidhu moose wala', 'karan aujla', 'diljit dosanjh', 'guru randhawa'],
    'darshan raval':     ['arijit singh', 'jubin nautiyal', 'vishal mishra', 'b praak', 'armaan malik'],
    'harrdy sandhu':     ['guru randhawa', 'diljit dosanjh', 'jassie gill', 'b praak', 'ammy virk'],
    'hardy sandhu':      ['guru randhawa', 'diljit dosanjh', 'jassie gill', 'b praak', 'ammy virk'],
  };

  // Find related artists — match by substring so "yo yo honey singh" matches "honey singh" key
  let relatedArtists = [];
  const singerKey = singerName.trim().toLowerCase();
  for (const [key, related] of Object.entries(RELATED_ARTISTS_MAP)) {
    if (singerKey === key || singerKey.includes(key) || key.includes(singerKey)) {
      relatedArtists = related;
      break;
    }
  }

  const queries = [];

  if (singerName) {
    // Query 1: Direct singer name — top hits
    queries.push({ query: `${singerName} top hit songs hindi punjabi`, tag: 'artist_direct', weight: 3 });
    // Query 2: Singer playlist
    queries.push({ query: `${singerName} all songs best playlist`, tag: 'artist_playlist', weight: 2 });
  }

  // Query 3: Related artists (pick top 2)
  if (relatedArtists.length > 0) {
    const topRelated = relatedArtists.slice(0, 2);
    for (const ra of topRelated) {
      queries.push({ query: `${ra} top hit songs hindi punjabi`, tag: 'related_artist', weight: 1 });
    }
  }

  // Query 4: Vibe match — ensures same language is anchored
  if (singerName) {
    queries.push({ query: `${singerName} superhit songs party dj`, tag: 'vibe_match', weight: 1 });
  } else if (normalizedCurrent) {
    queries.push({ query: `${normalizedCurrent} similar hindi punjabi party songs`, tag: 'vibe_match', weight: 1 });
  }

  // Query 5: Fallback — only if no singer detected at all
  if (!singerName) {
    queries.push({ query: `top bollywood punjabi party songs 2024 hindi`, tag: 'generic_fallback', weight: 0 });
  }

  return { queries, singerName, normalizedCurrent };
}

// --- History Tracking ---
function addToHistory(room, song) {
  if (!room || !song || !song.url) return;
  if (!room.playedHistory) room.playedHistory = [];
  if (!room.playedHistory.includes(song.url)) {
    room.playedHistory.push(song.url);
  }
  // Also track normalized titles to catch cross-channel duplicates
  if (!room.playedTitleHistory) room.playedTitleHistory = [];
  const normTitle = normalizeTitle(song.title || '');
  if (normTitle && !room.playedTitleHistory.includes(normTitle)) {
    room.playedTitleHistory.push(normTitle);
  }
  // Keep history bounded
  if (room.playedHistory.length > 30) room.playedHistory.shift();
  if (room.playedTitleHistory.length > 30) room.playedTitleHistory.shift();
}

// --- Fallback Song Playback ---
// Only used as absolute last resort if YouTube search completely fails
function playFallbackSong(room, roomCode, previousSong) {
  addToHistory(room, previousSong);
  console.log(`[Autoplay Fallback] YouTube search failed. Attempting generic Bollywood fallback for room ${roomCode}`);

  // Instead of hardcoded SoundHelix, try one last generic YouTube search
  yts("top bollywood party songs 2024 playlist").then(res => {
    const videos = (res.videos || []).filter(v => {
      const dur = v.seconds || 0;
      return dur >= 120 && dur <= 480 && !isBadVideoType(v.title);
    });

    if (videos.length > 0) {
      const pick = videos[Math.floor(Math.random() * Math.min(10, videos.length))];
      const autoplaySong = {
        id: pick.videoId,
        title: pick.title,
        artist: (pick.author && pick.author.name) || "Autoplay",
        album: "Autoplay Related",
        duration: pick.seconds || 180,
        albumArt: pick.thumbnail || pick.image || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
        url: pick.videoId,
        addedBy: "Autoplay Fallback",
        addedAt: Date.now(),
      };
      room.currentSong = { ...autoplaySong, isPlaying: true, progress: 0, startTime: Date.now() };
      io.to(roomCode).emit("song:change", room.currentSong);
      logRoomEvent(room, `Autoplay fallback started song: "${autoplaySong.title}"`);
    }
  }).catch(err => {
    console.error(`[Autoplay Fallback] Even generic search failed for room ${roomCode}:`, err);
  });
}


// ============================================================================
// MAIN AUTOPLAY QUEUE ENGINE
// ============================================================================
async function fillAutoplayQueue(room, roomCode, currentSongOrLastPlayed) {
  if (!room || !currentSongOrLastPlayed) return;
  if (!room.autoplayQueue) room.autoplayQueue = [];

  // If the autoplay queue already has 5 or more songs, skip
  if (room.autoplayQueue.length >= 5) {
    io.to(room.hostSocketId).emit("autoplayQueue:update", room.autoplayQueue);
    return;
  }

  try {
    const rawTitle = currentSongOrLastPlayed.title || "";
    const rawArtist = currentSongOrLastPlayed.artist || "";

    // STEP 1: Build normalized data for the current song
    const { queries, singerName, normalizedCurrent } = buildSmartQueries(rawTitle, rawArtist);
    const currentSingerWords = singerName.split(' ').filter(w => w.length > 1);

    if (!room.playedHistory) room.playedHistory = [];
    if (!room.playedTitleHistory) room.playedTitleHistory = [];

    console.log(`[Autoplay Engine] Current: "${rawTitle}" | Singer: "${singerName}" | Normalized: "${normalizedCurrent}"`);
    console.log(`[Autoplay Engine] Executing ${queries.length} search queries...`);

    // STEP 2: Execute all search queries in parallel
    const searchResults = await Promise.all(
      queries.map(async (q) => {
        try {
          const res = await yts(q.query);
          return { videos: res.videos || [], tag: q.tag, weight: q.weight };
        } catch (e) {
          console.warn(`[Autoplay Engine] Query failed: "${q.query}"`, e.message);
          return { videos: [], tag: q.tag, weight: q.weight };
        }
      })
    );

    // STEP 3: Combine all results with metadata
    const allVideos = [];
    const seenVideoIds = new Set();
    for (const result of searchResults) {
      for (const v of result.videos) {
        if (!seenVideoIds.has(v.videoId)) {
          seenVideoIds.add(v.videoId);
          allVideos.push({ ...v, _tag: result.tag, _weight: result.weight });
        }
      }
    }

    console.log(`[Autoplay Engine] Total unique candidates before filtering: ${allVideos.length}`);

    // STEP 4: STRICT FILTERING PIPELINE
    const candidates = [];
    const seenNormalizedTitles = new Set();

    // Add already-known normalized titles from autoplay queue
    for (const q of room.autoplayQueue) {
      seenNormalizedTitles.add(normalizeTitle(q.title || ''));
    }

    for (const v of allVideos) {
      const vId = v.videoId;
      const vTitle = v.title || '';
      const vNormTitle = normalizeTitle(vTitle);
      const vDuration = v.seconds || 0;

      // --- FILTER 1: Skip exact same video ---
      if (vId === currentSongOrLastPlayed.url || vId === currentSongOrLastPlayed.id) continue;

      // --- FILTER 2: Skip if already in history, queue, or autoplay queue ---
      if (room.playedHistory.includes(vId)) continue;
      if (room.queue.some(q => q.url === vId)) continue;
      if (room.autoplayQueue.some(q => q.url === vId)) continue;

      // --- FILTER 3: Duration check (real songs are 2-8 minutes) ---
      if (vDuration < 90 || vDuration > 480) continue;

      // --- FILTER 4: Bad video type (teaser, trailer, reaction, remix, beats, etc.) ---
      const vChannel = (v.author && v.author.name) || '';
      if (isBadVideoType(vTitle, vChannel)) {
        console.log(`[Autoplay Filter] BLOCKED bad type: "${vTitle}" (channel: "${vChannel}")`);
        continue;
      }

      // --- FILTER 4b: Wrong language / regional content ---
      if (isWrongLanguage(vTitle, vChannel)) {
        console.log(`[Autoplay Filter] BLOCKED wrong language: "${vTitle}" (channel: "${vChannel}")`);
        continue;
      }

      // --- FILTER 5: SEMANTIC DUPLICATE — is this the SAME SONG as currently playing? ---
      if (isDuplicateSong(normalizedCurrent, vNormTitle, currentSingerWords)) {
        console.log(`[Autoplay Filter] BLOCKED duplicate: "${vTitle}" (normalized: "${vNormTitle}" ≈ "${normalizedCurrent}")`);
        continue;
      }

      // --- FILTER 6: Check against already-played normalized titles ---
      if (room.playedTitleHistory.includes(vNormTitle)) continue;

      // --- FILTER 7: Prevent multiple versions of the same song in results ---
      if (seenNormalizedTitles.has(vNormTitle)) continue;
      seenNormalizedTitles.add(vNormTitle);

      // --- PASSED ALL FILTERS ---
      const score = scoreCandidate(v, singerName, currentSingerWords, v._tag === 'artist_direct' || v._tag === 'artist_playlist');
      candidates.push({ ...v, _score: score + (v._weight * 100) });
    }

    console.log(`[Autoplay Engine] Candidates after filtering: ${candidates.length}`);

    // STEP 5: Sort by score (descending)
    candidates.sort((a, b) => b._score - a._score);

    // STEP 6: Pick top candidates and add to autoplay queue
    const needed = 5 - room.autoplayQueue.length;
    const picked = candidates.slice(0, Math.min(needed, candidates.length));

    for (const v of picked) {
      const autoplaySong = {
        id: v.videoId,
        title: v.title,
        artist: (v.author && v.author.name) || "Autoplay",
        album: "Autoplay Related",
        duration: v.seconds || 180,
        albumArt: v.thumbnail || v.image || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
        url: v.videoId,
        addedBy: "Autoplay",
        addedAt: Date.now(),
      };
      room.autoplayQueue.push(autoplaySong);
      console.log(`[Autoplay Engine] ✓ Added: "${v.title}" (score: ${v._score}, tag: ${v._tag})`);
    }

    // STEP 7: If still not enough, try broader related queries
    if (room.autoplayQueue.length < 5) {
      console.log(`[Autoplay Engine] Only ${room.autoplayQueue.length}/5 songs. Running broader fallback search...`);

      const fallbackQueries = [
        `top hindi punjabi party songs 2024`,
        `best bollywood dance songs playlist`,
        singerName ? `${singerName} type beat hindi punjabi` : `trending punjabi songs`,
      ];

      for (const fq of fallbackQueries) {
        if (room.autoplayQueue.length >= 5) break;
        try {
          const fbRes = await yts(fq);
          const fbVideos = (fbRes.videos || []).filter(v => {
            const dur = v.seconds || 0;
            const vNorm = normalizeTitle(v.title || '');
            return dur >= 90 && dur <= 480
              && !isBadVideoType(v.title)
              && !isDuplicateSong(normalizedCurrent, vNorm, currentSingerWords)
              && !room.playedHistory.includes(v.videoId)
              && !room.queue.some(q => q.url === v.videoId)
              && !room.autoplayQueue.some(q => q.url === v.videoId)
              && !seenNormalizedTitles.has(vNorm);
          });

          for (const v of fbVideos) {
            if (room.autoplayQueue.length >= 5) break;
            const vNorm = normalizeTitle(v.title || '');
            seenNormalizedTitles.add(vNorm);
            room.autoplayQueue.push({
              id: v.videoId,
              title: v.title,
              artist: (v.author && v.author.name) || "Autoplay",
              album: "Autoplay Related",
              duration: v.seconds || 180,
              albumArt: v.thumbnail || v.image || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
              url: v.videoId,
              addedBy: "Autoplay",
              addedAt: Date.now(),
            });
            console.log(`[Autoplay Engine] ✓ Fallback added: "${v.title}"`);
          }
        } catch (e) {
          console.warn(`[Autoplay Engine] Fallback query failed: "${fq}"`);
        }
      }
    }

    console.log(`[Autoplay Engine] Final queue size: ${room.autoplayQueue.length}`);
    room.autoplayQueue.forEach((s, i) => console.log(`  [${i + 1}] ${s.title}`));

    // Broadcast updated autoplay queue to host
    io.to(room.hostSocketId).emit("autoplayQueue:update", room.autoplayQueue);
  } catch (err) {
    console.error(
      `[Autoplay Engine] Critical error for room ${roomCode}:`,
      err,
    );
    // Emergency fallback — try a simple generic search
    try {
      const emergencyRes = await yts("top bollywood punjabi hits 2024");
      const emergencyVideos = (emergencyRes.videos || []).filter(v => (v.seconds || 0) >= 120 && (v.seconds || 0) <= 480);
      for (const v of emergencyVideos) {
        if (room.autoplayQueue.length >= 5) break;
        if (!room.autoplayQueue.some(q => q.url === v.videoId)) {
          room.autoplayQueue.push({
            id: v.videoId,
            title: v.title,
            artist: (v.author && v.author.name) || "Autoplay",
            album: "Autoplay Related",
            duration: v.seconds || 180,
            albumArt: v.thumbnail || v.image || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
            url: v.videoId,
            addedBy: "Autoplay Emergency",
            addedAt: Date.now(),
          });
        }
      }
    } catch (e) {
      console.error(`[Autoplay Engine] Emergency fallback also failed:`, e);
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

    addToHistory(room, previousSong);

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

function isPrivateIp(ip) {
  if (!ip) return false;
  const norm = ip.replace(/^::ffff:/, "").trim();
  return (
    norm.startsWith("192.") ||
    norm.startsWith("10.") ||
    norm.startsWith("127.") ||
    norm === "::1" ||
    norm.startsWith("172.")
  );
}

function isSameLocalNetwork(ip1, ip2) {
  if (!ip1 || !ip2) return false;

  const norm1 = ip1.replace(/^::ffff:/, "").trim();
  const norm2 = ip2.replace(/^::ffff:/, "").trim();

  if (norm1 === norm2) return true;

  const isLoopback1 = norm1 === "127.0.0.1" || norm1 === "::1";
  const isLoopback2 = norm2 === "127.0.0.1" || norm2 === "::1";
  if (isLoopback1 && isLoopback2) return true;

  if (isPrivateIp(norm1) && isPrivateIp(norm2)) {
    return true; // Any two private/local IPs are on the same local network
  }

  return false;
}

// Expose discovery API
app.get("/api/rooms", rateLimiter, (req, res) => {
  const isLocalOnly = req.query.local === "true";
  const clientIp =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";

  let roomList = Array.from(rooms.values()).filter((room) => !room.isUnlisted);

  if (isLocalOnly) {
    roomList = roomList.filter((room) => {
      // Find host user's IP
      const hostUser = room.users.find((u) => u.isHost);
      const hostIp = hostUser ? hostUser.ip : null;

      if (!hostIp) return false;
      return isSameLocalNetwork(clientIp, hostIp);
    });
  }

  const activeRooms = roomList.map((room) => {
    const hostUser = room.users.find((u) => u.isHost);
    const hostIp = hostUser ? hostUser.ip : null;
    const isLocal = hostIp ? isSameLocalNetwork(clientIp, hostIp) : false;

    return {
      roomCode: room.roomCode,
      roomName: room.roomName,
      hostName: room.hostName,
      userCount: room.users.length,
      isPrivate: !!room.password,
      isLocal,
      currentSong: room.currentSong
        ? {
            title: room.currentSong.title,
            artist: room.currentSong.artist,
            albumArt: room.currentSong.albumArt,
            isPlaying: room.currentSong.isPlaying,
          }
        : null,
    };
  });
  res.json(activeRooms);
});

// Expose local network info API
app.get("/api/network", (req, res) => {
  res.json({ ip: LOCAL_IP });
});

// Mail Transporter Configuration
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || "smtp.gmail.com",
  port: parseInt(process.env.MAIL_PORT || "465", 10),
  secure: process.env.MAIL_ENCRYPTION === "ssl", // true for 465, false for other ports
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
  connectionTimeout: 8000, // 8 seconds timeout to prevent hanging on blocked cloud networks
  greetingTimeout: 8000,
  socketTimeout: 8000,
});

// Feedback Endpoint
app.post("/api/feedback", rateLimiter, async (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ success: false, message: "Subject and message are required." });
  }

  const senderName = name?.trim() || "Anonymous Guest";
  const senderEmail = email?.trim() || "Not Provided";
  const timestamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });

  const mailHTML = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #090909;
            color: #ffffff;
            margin: 0;
            padding: 20px;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #121212;
            border-radius: 16px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            overflow: hidden;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5);
          }
          .header {
            background-color: #1a1a1a;
            padding: 30px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            text-align: center;
          }
          .logo {
            color: #1db954;
            font-size: 24px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: 2px;
            margin-bottom: 5px;
          }
          .subtitle {
            color: #b3b3b3;
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
          .body {
            padding: 40px 30px;
          }
          .field-group {
            margin-bottom: 25px;
          }
          .label {
            color: #b3b3b3;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 6px;
          }
          .value {
            color: #ffffff;
            font-size: 14px;
            font-weight: 600;
          }
          .message-box {
            background-color: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 20px;
            color: #e5e5e5;
            font-size: 14px;
            line-height: 1.6;
            white-space: pre-wrap;
          }
          .footer {
            background-color: #0b0b0b;
            padding: 20px 30px;
            border-top: 1px solid rgba(255, 255, 255, 0.05);
            text-align: center;
            font-size: 10px;
            color: #7a7a7a;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">LocalParty</div>
            <div class="subtitle">New User Feedback Received</div>
          </div>
          <div class="body">
            <div class="field-group" style="display: flex; gap: 20px; flex-wrap: wrap;">
              <div style="flex: 1; min-width: 150px;">
                <div class="label">Sender Name</div>
                <div class="value">${senderName}</div>
              </div>
              <div style="flex: 1; min-width: 150px;">
                <div class="label">Sender Email</div>
                <div class="value" style="color: #1db954;">${senderEmail}</div>
              </div>
            </div>

            <div class="field-group">
              <div class="label">Subject</div>
              <div class="value" style="font-size: 16px; color: #ffffff; font-weight: 800;">${subject}</div>
            </div>

            <div class="field-group">
              <div class="label">Feedback Message</div>
              <div class="message-box">${message}</div>
            </div>
            
            <div style="margin-top: 30px; font-size: 11px; color: #7a7a7a; font-weight: 500;">
              Submitted at ${timestamp} (Asia/Kolkata timezone)
            </div>
          </div>
          <div class="footer">
            LocalParty &copy; ${new Date().getFullYear()} &bull; Developed by Developers of Emerging Coders
          </div>
        </div>
      </body>
    </html>
  `;

  const recipients = ["emergingcoders12@gmail.com", "hatim886644@gmail.com"];

  try {
    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || "LocalParty"}" <${process.env.MAIL_FROM_ADDRESS || process.env.MAIL_USERNAME}>`,
      to: recipients.join(", "),
      subject: `[LocalParty Feedback] ${subject}`,
      html: mailHTML,
    });

    console.log(`Feedback mail successfully sent to ${recipients.join(", ")}`);
    res.json({ success: true, message: "Feedback sent successfully!" });
  } catch (error) {
    console.error("Error sending feedback email:", error);
    // Explicitly identify firewall drops/timeouts on SMTP ports (standard on Render Free Tier)
    const isTimeout = error.code === 'ETIMEDOUT' || error.message?.includes('timeout') || error.message?.includes('connect') || error.code === 'ECONNRESET';
    if (isTimeout && (process.env.RENDER || error.address?.includes('smtp'))) {
      res.status(500).json({ 
        success: false, 
        message: "SMTP Connection Timed Out. Render Free Tier blocks outbound SMTP traffic on ports 25, 465, and 587. Please upgrade your Render instance or run the server locally." 
      });
    } else {
      res.status(500).json({ success: false, message: `Failed to send feedback email: ${error.message || 'Server error'}` });
    }
  }
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
    // Limit results for faster response and clean UI (default 30, max 50)
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const videos = (r.videos || []).slice(0, limit);
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
    ({ roomName, hostName, password, systemIp, permissions, isUnlisted }, callback) => {
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
            ip: systemIp || getClientIp(socket),
          },
        ],
        currentSong: null,
        queue: [],
        autoplayQueue: [],
        playedHistory: [],
        auditLog: [],
        password: password || null,
        isUnlisted: !!isUnlisted,
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
  socket.on("room:join", ({ roomCode, name, password, systemIp }, callback) => {
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
      ip: systemIp || getClientIp(socket),
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
    ({ roomCode, role, username, password, systemIp }, callback) => {
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
          if (systemIp) hostUser.ip = systemIp;
        } else {
          room.users.push({
            socketId: socket.id,
            name: username,
            isHost: true,
            ip: systemIp || getClientIp(socket),
          });
        }

        // Notify guests that the host is back online
        io.to(code).emit("room:host-status", { connected: true });
      } else {
        // Guest is reconnecting: Security check
        const guestUser = room.users.find((u) => u.name === username);
        if (guestUser) {
          guestUser.socketId = socket.id;
          if (systemIp) guestUser.ip = systemIp;
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
    addToHistory(room, previousSong);
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
      addToHistory(room, previousSong);

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
    
    // Force leave all sockets in the room channel
    const socketsInRoom = io.sockets.adapter.rooms.get(userRoomCode);
    if (socketsInRoom) {
      for (const socketId of socketsInRoom) {
        const s = io.sockets.sockets.get(socketId);
        if (s) {
          s.leave(userRoomCode);
        }
      }
    }
    
    rooms.delete(userRoomCode);
  });

  // User leaves room manually
  socket.on("room:leave", () => {
    handleLeave(true);
  });

  // Connection lost
  socket.on("disconnect", () => {
    handleLeave(false);
  });

  function handleLeave(isManual = false) {
    if (!userRoomCode) return;
    const room = rooms.get(userRoomCode);
    if (!room) return;

    const isHost = room.hostSocketId === socket.id;

    if (isManual) {
      if (isHost) {
        // Host leaving manually: close room immediately
        console.log(`Host left manually. Closing room: ${userRoomCode}`);
        io.to(userRoomCode).emit("room:ended");

        // Force leave all sockets in the room channel
        const socketsInRoom = io.sockets.adapter.rooms.get(userRoomCode);
        if (socketsInRoom) {
          for (const socketId of socketsInRoom) {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
              s.leave(userRoomCode);
            }
          }
        }

        clearRoomTimers(userRoomCode);
        rooms.delete(userRoomCode);
      } else {
        // Guest leaving manually: remove immediately
        const leavingUser = room.users.find((u) => u && u.socketId === socket.id);
        const disconnectedName = leavingUser ? leavingUser.name : "Unknown Guest";
        room.users = room.users.filter((u) => u && u.socketId !== socket.id);
        logRoomEvent(room, `Guest left manually: "${disconnectedName}"`);
        io.to(userRoomCode).emit("room:user-update", room.users);
        resetRoomActivity(userRoomCode);
      }
      userRoomCode = null;
    } else {
      // Socket disconnected (connection lost / page refresh)
      if (isHost) {
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

          // Force leave all sockets in the room channel
          const socketsInRoom = io.sockets.adapter.rooms.get(userRoomCode);
          if (socketsInRoom) {
            for (const socketId of socketsInRoom) {
              const s = io.sockets.sockets.get(socketId);
              if (s) {
                s.leave(userRoomCode);
              }
            }
          }

          clearRoomTimers(userRoomCode);
          rooms.delete(userRoomCode);
        }, 15000); // 15 seconds

        roomDisconnectTimers.set(userRoomCode, timer);
      } else {
        // Guest disconnected: start 10s grace period
        const disconnectedSocketId = socket.id;
        const currentRoomCode = userRoomCode;
        const leavingUser = room.users.find((u) => u && u.socketId === disconnectedSocketId);
        const disconnectedName = leavingUser ? leavingUser.name : "Unknown Guest";
        logRoomEvent(room, `Guest disconnected: "${disconnectedName}". Starting 10s grace period.`);

        setTimeout(() => {
          const activeRoom = rooms.get(currentRoomCode);
          if (!activeRoom) return;

          const guestIndex = activeRoom.users.findIndex(
            (u) => u && u.socketId === disconnectedSocketId
          );

          if (guestIndex !== -1) {
            // Guest never re-bound their socket during grace period, remove them now
            activeRoom.users = activeRoom.users.filter((u) => u && u.socketId !== disconnectedSocketId);
            logRoomEvent(activeRoom, `Guest "${disconnectedName}" grace period expired. Removed from room.`);
            io.to(currentRoomCode).emit("room:user-update", activeRoom.users);
            resetRoomActivity(currentRoomCode);
          }
        }, 10000); // 10 seconds grace period
      }
      userRoomCode = null;
    }
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🎵 Local Party Music server running on port ${PORT}`);
  console.log(`🔗 Local WiFi IP to share: http://${LOCAL_IP}:${PORT}`);
  console.log(`======================================================\n`);
});
