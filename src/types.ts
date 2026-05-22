export interface Song {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  albumArt: string;
  url: string;
}

export interface PlayableSong extends Song {
  isPlaying: boolean;
  progress: number;
  startTime: number;
  addedBy: string;
}

export const MOCK_SONGS: Song[] = [
  {
    id: "s1",
    title: "Helix Echoes",
    artist: "SoundHelix Band",
    album: "Electronic Odyssey",
    duration: 372,
    albumArt: "https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"
  },
  {
    id: "s2",
    title: "Neon Skyline",
    artist: "SoundHelix Band",
    album: "Retro Waves",
    duration: 425,
    albumArt: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3"
  },
  {
    id: "s3",
    title: "Sunset Groove",
    artist: "SoundHelix Band",
    album: "Chill Lounge",
    duration: 344,
    albumArt: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3"
  },
  {
    id: "s4",
    title: "Synthwave Dreams",
    artist: "SoundHelix Band",
    album: "Futuristic Horizon",
    duration: 302,
    albumArt: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3"
  },
  {
    id: "s5",
    title: "Midnight City",
    artist: "SoundHelix Band",
    album: "Vapor Trails",
    duration: 363,
    albumArt: "https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3"
  },
  {
    id: "s6",
    title: "Summer Jam",
    artist: "SoundHelix Band",
    album: "Beach Vibin",
    duration: 312,
    albumArt: "https://images.unsplash.com/photo-1508700115892-45ecd05ae2ad?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3"
  },
  {
    id: "s7",
    title: "Deep Bass Quest",
    artist: "SoundHelix Band",
    album: "Sub Woofer",
    duration: 382,
    albumArt: "https://images.unsplash.com/photo-1516280440614-37939bbacd6a?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3"
  },
  {
    id: "s8",
    title: "Cosmic Voyage",
    artist: "SoundHelix Band",
    album: "Galaxy Travel",
    duration: 334,
    albumArt: "https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=300&q=80",
    url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3"
  }
];
