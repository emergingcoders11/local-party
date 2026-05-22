import React, { useEffect, useRef } from 'react';
import { X, AlertTriangle } from 'lucide-react';

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel'
}) => {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
            <AlertTriangle className="w-5 h-5 text-spotify-green" />
            <h3 className="text-lg font-bold font-sans">{title}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-white/10 transition text-spotify-text hover:text-white cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <p className="text-sm text-spotify-text text-center leading-relaxed mb-8">
          {message}
        </p>

        {/* Actions */}
        <div className="w-full flex flex-col gap-3">
          <button
            onClick={onConfirm}
            className="w-full py-3 rounded-full bg-spotify-green text-black font-extrabold text-sm hover:scale-102 active:scale-98 transition-all cursor-pointer shadow-md shadow-spotify-green/10"
          >
            {confirmText}
          </button>
          
          <button
            onClick={onClose}
            className="w-full py-3 rounded-full bg-white/5 hover:bg-white/10 text-white font-extrabold text-sm transition-all cursor-pointer border border-white/5"
          >
            {cancelText}
          </button>
        </div>
      </div>
    </dialog>
  );
};
