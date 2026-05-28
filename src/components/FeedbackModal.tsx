import React, { useEffect, useRef, useState } from 'react';
import { X, MessageSquare, Send, CheckCircle, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface FeedbackModalProps {
  isOpen: boolean;
  onClose: () => void;
  backendHost: string;
}

export const FeedbackModal: React.FC<FeedbackModalProps> = ({ isOpen, onClose, backendHost }) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      dialog.showModal();
      setStatus('idle');
      setSubject('');
      setMessage('');
      setName('');
      setEmail('');
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) {
      setStatus('error');
      setErrorMessage('Subject and message are required.');
      return;
    }

    setStatus('submitting');
    try {
      const getServerUrl = (host: string) => {
        return host.includes('://') 
          ? host 
          : `http://${host}${host.includes(':') ? '' : ':3001'}`;
      };
      const serverUrl = getServerUrl(backendHost);
      const response = await fetch(`${serverUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          subject: subject.trim(),
          message: message.trim(),
        }),
      });

      const resData = await response.json();
      if (response.ok && resData.success) {
        setStatus('success');
      } else {
        setStatus('error');
        setErrorMessage(resData.message || 'Failed to submit feedback.');
      }
    } catch (err) {
      console.error('Feedback submit error:', err);
      setStatus('error');
      setErrorMessage('Network error. Please try again.');
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="p-0 rounded-2xl glass-panel text-white max-w-md w-full border border-white/10 outline-hidden backdrop:bg-black/75 backdrop:backdrop-blur-xs"
      style={{ margin: 'auto' }}
    >
      <div className="p-6">
        {/* Header */}
        <div className="w-full flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-spotify-green" />
            <h3 className="text-lg font-bold font-sans">Share Your Feedback</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-white/10 transition text-spotify-text hover:text-white cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <AnimatePresence mode="wait">
          {status === 'success' ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="text-center py-8 flex flex-col items-center justify-center"
            >
              <CheckCircle className="w-16 h-16 text-spotify-green mb-4 animate-[float_4s_ease-in-out_infinite]" />
              <h4 className="text-xl font-bold mb-2">Thank you!</h4>
              <p className="text-spotify-text text-sm max-w-xs leading-relaxed">
                Your feedback has been successfully sent to the Emerging Coders developers team. We appreciate your suggestions!
              </p>
              <button
                onClick={onClose}
                className="mt-8 px-6 py-2.5 rounded-full bg-spotify-green text-black font-extrabold hover:scale-105 active:scale-95 transition-all cursor-pointer"
              >
                Close Window
              </button>
            </motion.div>
          ) : (
            <motion.form
              key="form"
              onSubmit={handleSubmit}
              className="space-y-4"
            >
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="feedback-name" className="block text-xxs font-bold uppercase tracking-wider text-spotify-text mb-1.5">
                    Your Name (Optional)
                  </label>
                  <input
                    id="feedback-name"
                    type="text"
                    placeholder="e.g. Anonymous"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={status === 'submitting'}
                    className="w-full px-3 py-2 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-xs"
                  />
                </div>
                <div>
                  <label htmlFor="feedback-email" className="block text-xxs font-bold uppercase tracking-wider text-spotify-text mb-1.5">
                    Your Email (Optional)
                  </label>
                  <input
                    id="feedback-email"
                    type="email"
                    placeholder="e.g. feedback@domain.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={status === 'submitting'}
                    className="w-full px-3 py-2 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-xs"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="feedback-subject" className="block text-xxs font-bold uppercase tracking-wider text-spotify-text mb-1.5">
                  Subject *
                </label>
                <input
                  id="feedback-subject"
                  type="text"
                  required
                  placeholder="e.g. Suggestion for surprise queue list"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={status === 'submitting'}
                  className="w-full px-3.5 py-2.5 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-xs font-semibold"
                />
              </div>

              <div>
                <label htmlFor="feedback-message" className="block text-xxs font-bold uppercase tracking-wider text-spotify-text mb-1.5">
                  Feedback Message *
                </label>
                <textarea
                  id="feedback-message"
                  required
                  rows={4}
                  placeholder="How can we make LocalParty even better for your social music parties?"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  disabled={status === 'submitting'}
                  className="w-full px-3.5 py-2.5 bg-spotify-light-gray/60 border border-white/5 rounded-xl text-white placeholder-spotify-text focus:outline-hidden focus:border-spotify-green/50 focus:ring-1 focus:ring-spotify-green/20 transition text-xs font-medium resize-none custom-scrollbar"
                />
              </div>

              {status === 'error' && (
                <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-xs">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span className="text-left font-medium">{errorMessage}</span>
                </div>
              )}

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={status === 'submitting'}
                  className="px-4 py-2 text-xs font-bold text-spotify-text hover:text-white transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={status === 'submitting'}
                  className="px-5 py-2.5 rounded-xl bg-spotify-green text-black font-extrabold text-xs flex items-center justify-center gap-1.5 hover:scale-102 hover:bg-spotify-green/95 active:scale-98 transition disabled:opacity-50 disabled:scale-100 cursor-pointer"
                >
                  {status === 'submitting' ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-black border-t-transparent rounded-full animate-spin"></div>
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      Send Feedback
                    </>
                  )}
                </button>
              </div>
            </motion.form>
          )}
        </AnimatePresence>
      </div>
    </dialog>
  );
};
