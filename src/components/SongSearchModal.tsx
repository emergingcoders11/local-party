/* eslint-disable react-hooks/set-state-in-effect */
import React, { useState, useEffect, useRef } from 'react';
import { X, Search, Plus, Check, Loader2, Music } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { type Song } from '../types';

interface SongSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddSong: (song: Song) => Promise<boolean>;
  backendHost: string;
}

export const SongSearchModal: React.FC<SongSearchModalProps> = ({ isOpen, onClose, onAddSong, backendHost }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [filteredSongs, setFilteredSongs] = useState<Song[]>([]);
  const [addingSongIds, setAddingSongIds] = useState<Record<string, 'loading' | 'done'>>({});
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Manage <dialog> HTML5 standard open state
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
      // Focus the search input when dialog opens
      setTimeout(() => {
        const input = dialog.querySelector('input');
        input?.focus();
      }, 50);
    } else {
      dialog.close();
    }
  }, [isOpen]);

  // Fallback for light-dismiss on browsers that don't support it natively
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleOutsideClick = (e: MouseEvent) => {
      if (e.target !== dialog) return;
      
      const rect = dialog.getBoundingClientRect();
      const clickInside = (
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width
      );

      if (!clickInside) {
        onClose();
      }
    };

    dialog.addEventListener('click', handleOutsideClick);
    return () => {
      dialog.removeEventListener('click', handleOutsideClick);
    };
  }, [onClose]);

  // Fetch songs from iTunes Search API with debouncing
  useEffect(() => {
    if (!isOpen) return;

    setIsSearching(true);
    const term = searchQuery.trim() || 'trending';
    
    const delayDebounce = setTimeout(async () => {
      try {
        const serverUrl = `http://${backendHost}:3001`;
        const response = await fetch(
          `${serverUrl}/api/search?q=${encodeURIComponent(term)}`
        );
        const data = await response.json();
        setFilteredSongs(data || []);
      } catch (error) {
        console.error('Error searching local YouTube API:', error);
      } finally {
        setIsSearching(false);
      }
    }, searchQuery ? 400 : 0); // Trigger instantly for empty initial search (e.g. "trending")

    return () => clearTimeout(delayDebounce);
  }, [searchQuery, isOpen, backendHost]);

  const handleAdd = async (song: Song) => {
    if (addingSongIds[song.id]) return;

    setAddingSongIds(prev => ({ ...prev, [song.id]: 'loading' }));
    
    // Call the parent handler to add to queue (emits over socket)
    const success = await onAddSong(song);
    
    if (success) {
      setAddingSongIds(prev => ({ ...prev, [song.id]: 'done' }));
      // Revert back to original state after 2 seconds
      setTimeout(() => {
        setAddingSongIds(prev => {
          const updated = { ...prev };
          delete updated[song.id];
          return updated;
        });
      }, 2000);
    } else {
      setAddingSongIds(prev => {
        const updated = { ...prev };
        delete updated[song.id];
        return updated;
      });
    }
  };

  const formatDuration = (secs: number) => {
    const minutes = Math.floor(secs / 60);
    const seconds = secs % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      closedby="any"
      className="p-0 rounded-2xl glass-panel text-white max-w-lg w-full outline-hidden border border-white/10 backdrop:bg-black/60 backdrop:backdrop-blur-xs"
      style={{ margin: 'auto' }}
    >
      <div className="p-6 flex flex-col h-[500px] overflow-hidden">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <Music className="w-5 h-5 text-spotify-green animate-pulse" />
            <h3 className="text-xl font-bold font-sans">Suggest a Surprise Song</h3>
          </div>
          <button 
            onClick={onClose} 
            className="p-1.5 rounded-full hover:bg-white/10 transition text-spotify-text hover:text-white"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="relative mb-6">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-spotify-text" />
          <input
            type="text"
            placeholder="Search by title, artist, or album..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-4 py-3 bg-spotify-light-gray/60 border border-white/5 rounded-full text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/30 transition text-sm"
          />
        </div>

        {/* Content Container */}
        <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
          {isSearching ? (
            /* Skeleton Loading State */
            <div className="space-y-4">
              {[1, 2, 3, 4].map(idx => (
                <div key={idx} className="flex items-center gap-3 p-2 rounded-xl animate-pulse">
                  <div className="w-12 h-12 bg-white/5 rounded-md" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-white/10 rounded w-1/3" />
                    <div className="h-3 bg-white/5 rounded w-1/4" />
                  </div>
                  <div className="w-8 h-8 bg-white/5 rounded-full" />
                </div>
              ))}
            </div>
          ) : filteredSongs.length === 0 ? (
            /* Empty State */
            <div className="flex flex-col items-center justify-center h-full py-12 text-center text-spotify-text">
              <Search className="w-12 h-12 mb-3 stroke-[1.5] text-spotify-text/40" />
              <p className="text-sm font-semibold">No songs match your search</p>
              <p className="text-xs mt-1">Try another title, artist or genre!</p>
            </div>
          ) : (
            /* Songs List */
            <div className="space-y-2">
              <AnimatePresence>
                {filteredSongs.map((song) => (
                  <motion.div
                    key={song.id}
                    layout
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition group"
                  >
                    <img 
                      src={song.albumArt} 
                      alt={song.album} 
                      className="w-12 h-12 rounded-md object-cover border border-white/5 group-hover:scale-105 transition duration-300"
                    />
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-bold text-white truncate">{song.title}</h4>
                      <p className="text-xs text-spotify-text truncate mt-0.5">
                        {song.artist} • {song.album}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-spotify-text group-hover:text-white transition">
                        {formatDuration(song.duration)}
                      </span>
                      <button
                        onClick={() => handleAdd(song)}
                        disabled={addingSongIds[song.id] === 'loading'}
                        className={`p-2 rounded-full border transition flex items-center justify-center cursor-pointer ${
                          addingSongIds[song.id] === 'done'
                            ? 'bg-spotify-green border-spotify-green text-black'
                            : addingSongIds[song.id] === 'loading'
                            ? 'bg-white/10 border-transparent text-white'
                            : 'border-white/10 text-white hover:border-spotify-green hover:bg-spotify-green hover:text-black'
                        }`}
                      >
                        {addingSongIds[song.id] === 'done' ? (
                          <Check className="w-4 h-4 stroke-[3]" />
                        ) : addingSongIds[song.id] === 'loading' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
};
