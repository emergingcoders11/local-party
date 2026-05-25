import React, { useEffect, useRef } from 'react';
import { ShieldAlert, RefreshCw } from 'lucide-react';

interface InactivityWarningModalProps {
  isOpen: boolean;
  countdown: number; // countdown in seconds
  onContinue: () => void;
}

export const InactivityWarningModal: React.FC<InactivityWarningModalProps> = ({
  isOpen,
  countdown,
  onContinue
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      // Prevent closing via Escape key
      const handleCancel = (e: Event) => {
        e.preventDefault();
      };
      dialog.addEventListener('cancel', handleCancel);
      
      if (!dialog.open) {
        dialog.showModal();
      }
      
      return () => {
        dialog.removeEventListener('cancel', handleCancel);
      };
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isOpen]);

  // Format countdown seconds as MM:SS
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <dialog
      ref={dialogRef}
      className="p-0 rounded-2xl glass-panel text-white max-w-sm w-full border border-red-500/20 outline-hidden backdrop:bg-black/80 backdrop:backdrop-blur-md shadow-2xl shadow-red-500/5"
      style={{ margin: 'auto' }}
    >
      <div className="p-8 flex flex-col items-center">
        {/* Animated Warning Icon */}
        <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center mb-6 animate-pulse">
          <ShieldAlert className="w-8 h-8 text-red-500 animate-bounce" />
        </div>

        {/* Title */}
        <h3 className="text-xl font-black font-sans mb-3 tracking-wide text-center uppercase text-red-400">
          Inactivity Warning
        </h3>

        {/* Description */}
        <p className="text-sm text-spotify-text text-center leading-relaxed mb-6 px-2">
          No activity has been detected in this room for 1 hour. This room will be destroyed automatically to free up resources in:
        </p>

        {/* Big Countdown Timer */}
        <div className="text-5xl font-mono font-black text-white bg-white/5 border border-white/10 rounded-2xl px-6 py-4 mb-8 tracking-widest text-center shadow-inner">
          {formatTime(countdown)}
        </div>

        {/* Actions */}
        <button
          onClick={onContinue}
          className="w-full py-4 rounded-full bg-spotify-green text-black font-extrabold text-sm hover:scale-102 active:scale-98 transition-all cursor-pointer shadow-lg shadow-spotify-green/20 flex items-center justify-center gap-2 hover:bg-green-400"
        >
          <RefreshCw className="w-4 h-4 animate-spin-slow" />
          Continue Party
        </button>
      </div>
    </dialog>
  );
};
