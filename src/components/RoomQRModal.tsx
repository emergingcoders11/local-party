import React, { useEffect, useRef, useState } from 'react';
import { X, Copy, Check, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';

interface RoomQRModalProps {
  isOpen: boolean;
  onClose: () => void;
  roomCode: string;
  localIp: string;
}

export const RoomQRModal: React.FC<RoomQRModalProps> = ({ isOpen, onClose, roomCode, localIp }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  // Dynamically compute the join link
  const host = localIp || window.location.hostname;
  // If we are on port 5173 (dev), guests should hit 5173. Let's resolve the port properly.
  const port = window.location.port ? `:${window.location.port}` : '';
  const joinUrl = `${window.location.protocol}//${host}${port}/?room=${roomCode}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
    } else {
      dialog.close();
    }
  }, [isOpen]);

  // Click outside backdrop fallback handler
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

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="p-0 rounded-2xl glass-panel text-white max-w-sm w-full border border-white/10 outline-hidden backdrop:bg-black/75 backdrop:backdrop-blur-xs"
      style={{ margin: 'auto' }}
    >
      <div className="p-6 flex flex-col items-center">
        {/* Header */}
        <div className="w-full flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <QrCode className="w-5 h-5 text-spotify-green" />
            <h3 className="text-lg font-bold font-sans">Share Party Invite</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-white/10 transition text-spotify-text hover:text-white"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* QR Code Container */}
        <div className="bg-white p-4 rounded-xl shadow-lg mb-6 border border-white/10">
          <QRCodeSVG 
            value={joinUrl} 
            size={200}
            level="H"
            bgColor="#ffffff"
            fgColor="#121212"
            includeMargin={false}
          />
        </div>

        {/* Room Code Info */}
        <p className="text-xs text-spotify-text uppercase font-semibold tracking-widest mb-1">
          Room Join Code
        </p>
        <h2 className="text-3xl font-extrabold text-white tracking-widest bg-white/5 border border-white/5 py-2 px-6 rounded-lg mb-6">
          {roomCode}
        </h2>

        {/* Action Link Box */}
        <div className="w-full bg-spotify-light-gray/60 border border-white/5 rounded-xl p-3 flex items-center justify-between gap-3 text-xs mb-2">
          <span className="truncate text-spotify-text select-all">{joinUrl}</span>
          <button
            onClick={handleCopyLink}
            className="flex-shrink-0 p-2 rounded-lg bg-white/5 text-spotify-text hover:text-white hover:bg-white/10 transition cursor-pointer"
            title="Copy Join URL"
          >
            {copied ? <Check className="w-4 h-4 text-spotify-green" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>

        <p className="text-xxs text-center text-spotify-text leading-relaxed">
          Tell guests to connect to the same WiFi network and scan this code or open the link to join the surprise party queue!
        </p>
      </div>
    </dialog>
  );
};
