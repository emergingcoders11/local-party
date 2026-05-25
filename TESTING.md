# LocalParty Test Suite - Verification Scenarios

This document serves as the official manual testing checklist for **LocalParty**. Follow these guidelines and scenarios to verify correct behavior across modules.

---

## 1. Local Staging Setup

1. **Start the signaling and backend server**:
   ```bash
   node server.js
   ```
   *The backend should run on port `3001`.*

2. **Launch the web application client**:
   ```bash
   npm run dev
   ```
   *The frontend development server will launch (usually on `http://localhost:5173`).*

---

## 2. Test Scenario Checklist

### Test Scenario 1: Setup Room & Real Client IP Parsing
- **Setup**: Open the browser to the web frontend and click "Host a Party Room".
- **Steps**:
  1. Input room name (e.g., "Rock Jam Session").
  2. Input nickname (e.g., "DJ Host").
  3. Expand the "Guest Control Permissions" section (verify it renders cleanly).
  4. Leave permissions at default values and click "Launch Party Room".
  5. Open a second browser tab (or use a separate device on the same local network) and navigate to the landing page.
  6. Click "Join Existing Party", input the 5-letter room code, input a guest name (e.g., "Guest One"), and click "Join Room".
- **Expected Outcome & Verifications**:
  - The host displays the room information and control console.
  - The host's user panel lists both "DJ Host" and "Guest One".
  - **IP Parsing**: If "Guest One" connected from another device on the local network, the host's member list displays the guest's actual local IP address (e.g., `192.168.x.x`) instead of `localhost`. If connected on the same machine, it displays `localhost` as a safe fallback.

---

### Test Scenario 2: Customizable Room Permissions
- **Setup**: Create a new room as host. Toggle permissions in the collapsible settings panel as follows:
  - Skip Songs: **False**
  - Seek Progress & Rewind 10s: **False**
  - Play/Pause Songs: **False**
  - Guests Start Muted (prevent echoes): **True**
  - Display Video for Guests: **False**
- **Steps**:
  1. Join the room as "Guest One" on another browser / device.
  2. As the host, search for a song (e.g., "Never Gonna Give You Up") and add it to start playing.
  3. Look at the guest's browser interface.
- **Expected Outcome & Verifications**:
  - **Initial Mute**: Verify that the guest client joins in **Muted** state (`isMuted = true` and speaker volume slashed) to prevent browser echoes.
  - **Mute / Unmute Playback Trigger**: Click the "Unmute" button on the guest interface. Verify that the song immediately unmutes and starts playing audio in real-time, aligned with the host.
  - **Skip Song Lock**: Verify that the skip (`>>`) button is completely hidden or disabled for the guest.
  - **Play/Pause Song Lock**: Verify that the play/pause button is disabled for the guest.
  - **Seek/Progress Slider Lock**: Verify that the guest's slider thumb is non-interactive/disabled, and that offset buttons (`-10s`, `+10s`) are missing or locked.
  - **Display Video Permission**: Verify that the guest client does NOT render the YouTube player iframe. Instead, verify that they see a beautiful, spinning vinyl record card displaying the song's thumbnail, alongside an active animated CSS visualizer bar widget.

---

### Test Scenario 3: Real-time Sync & Progression Interpolation
- **Setup**: Establish a synchronized session with one host and two guests.
- **Steps**:
  1. As host, click "Play" and let the song run.
  2. Observe the progress sliders on both host and guest interfaces.
  3. As host, click the `+10s` seek offset or drag the progress bar thumb to seek to a later section.
  4. As host, click "Pause", wait 3 seconds, and then click "Play".
- **Expected Outcome & Verifications**:
  - **Interpolation**: The progress slider handles on all devices glide smoothly every 100ms in lockstep, with no visible 1-second stutters.
  - **Tighter Drift Alignment**: Guests align and seek to the host's exact timeline position in less than 1.2 seconds, matching the host's progress.
  - **State Changes**: When the host pauses or plays, guests pause or play within 500ms, maintaining strict real-time audio sync.

---

### Test Scenario 4: Autoplay Prospective Queue
- **Setup**: Create a room, add a single song to the queue, and let it play.
- **Steps**:
  1. Ensure no other songs are in the active queue list.
  2. Look at the host's queue sidebar panel.
  3. Let the active song play to completion (or click "Skip" on the host console).
- **Expected Outcome & Verifications**:
  - **Prospective Display**: The host's queue sidebar shows an "Up Next (Autoplay)" section displaying 5 upcoming random related songs generated from the active track.
  - **Seamless Autoplay Transition**: When the active song ends or is skipped, the first track in the prospective queue is automatically shifted to `currentSong` and starts playing.
  - **Queue Replenishment**: The prospective queue automatically replenishes itself with new candidates, maintaining a constant buffer of 5 prospective songs.

---

### Test Scenario 5: Queue Reordering
- **Setup**: Host a room and add 3 different songs (e.g., Song A, Song B, Song C) to the queue.
- **Steps**:
  1. Observe the host's queue list.
  2. Click the "Move Up" (▲) button on Song B.
  3. Click the "Move to Top" (🔝) button on Song C.
  4. Alternatively, drag Song C and drop it over Song A.
- **Expected Outcome & Verifications**:
  - The queue order changes in the UI instantly.
  - The server updates the in-memory array and updates the host's screen, maintaining the correct prioritized sequence.
  - When Song A finishes, the newly positioned top song plays first.

---

### Test Scenario 6: Mobile Background Playback & Lock-screen Media Session
- **Setup**: Connect a mobile device (iOS/Android browser) as a guest or host to the room.
- **Steps**:
  1. Start playing a track. Unmute the mobile device.
  2. Minimize the mobile browser app, switch to another application, or lock the mobile screen.
  3. Wake the screen to view the system's lock screen notification.
  4. Tap the "Play", "Pause", or "Next" control actions directly on the native lock screen notification panel.
- **Expected Outcome & Verifications**:
  - **Persistent Audio**: Audio does not stop or freeze when the browser tab goes out of focus. The looping base64 WAV stream successfully holds the audio context.
  - **System Notifications**: The native system notification display correctly shows the active song title, artist, and album art.
  - **Control Action Callbacks**: Tapping system play/pause or next track correctly pauses/plays the room playback or skips the song (subject to room permissions), updating the active room state instantly.

---

### Test Scenario 7: Inactivity warning & Persistent Archived Session Cover
- **Setup**: To speed up verification, set environment variables to reduce timeouts:
  - `INACTIVITY_TIMEOUT_MS=10000` (10 seconds)
  - `WARNING_TIMEOUT_MS=5000` (5 seconds)
  *Run server via:* `INACTIVITY_TIMEOUT_MS=10000 WARNING_TIMEOUT_MS=5000 node server.js`
- **Steps**:
  1. Host a room, but do not play any music.
  2. Wait 10 seconds.
  3. When the "Inactivity Warning" modal pops up, click "Continue Party" within 5 seconds.
  4. Wait another 10 seconds. Do not interact this time. Let the countdown expire.
- **Expected Outcome & Verifications**:
  - **Inactivity Warning Dialog**: The modal triggers at 10 seconds. Clicking "Continue Party" dismisses the modal with NO JavaScript `DOMException` error in the developer console.
  - **Activity Reset**: The room remains open and functional after dismissal.
  - **Archived Cover Overlay**: When the countdown expires, the room is destroyed. The host and guest interfaces are locked behind a gorgeous full-screen glassmorphic "Session Archived" cover overlay with a clear description and a prominent button to return to the main lobby.
