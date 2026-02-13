# Meet Call AlloyTrik - Project Documentation

This documentation provides a comprehensive overview of the **Meet-prototype** project, a WebRTC-based video conferencing application. It covers the architecture, key file functions, and main code scenarios.

## Project Overview

**Meet-prototype** is a real-time video calling application that allows up to 5 users to join a room. It uses **WebRTC** for peer-to-peer audio/video streaming and **Socket.IO** for signaling (exchanging connection data).

### Key Features
- **Video/Audio Calls**: Real-time communication using local camera and microphone.
- **Screen Sharing**: Ability to share screen with system audio.
- **Picture-in-Picture (PiP)**: Floating video window for multitasking.
- **Background Persistence**: Uses Wake Lock API to keep the connection active when the app is in the background.
- **Room Management**: Host/Guest logic where the first user is the host and controls access for others.

## Architecture

The project uses a **Full Mesh** topology.
- **Full Mesh**: Every participant connects directly to every other participant.
- **Signaling Server**: Managing the "handshake" between peers (finding each other on the internet). It does *not* process media traffic; media goes directly peer-to-peer.

## File Breakdown

### 1. `server/index.js` (The Signaling Server)
This Node.js server acts as the traffic controller. It listens on port `3000`.

**Key Responsibilities:**
- **Hosting Static Files**: Serves the `public` folder (HTML, CSS, JS) to the browser.
- **Socket.IO Events**:
    - `join-room`: Handles users joining. Assigns the first user as `host`.
    - `join-request` / `accept-user`: Logic for the "waiting room" feature.
    - `offer`, `answer`, `ice-candidate`: Relays WebRTC signaling data between peers.
    - `disconnect`: Handles user clean-up and host reassignment if the host leaves.

### 2. `public/index.html` (The User Interface)
The frontend structure.
- **Video Grid**: A responsive grid (`#video-grid`) that automatically adjusts layout based on the number of participants.
- **Controls**: Buttons for Join, Mute, Video, Screen Share, PiP, and Leave.
- **CSS**: Uses modern Glassmorphism styling and responsive design. Special classes like `.sharing-screen` handle layout changes during screen sharing.

### 3. `public/script.js` (The Client Logic)
This is the core of the application. It handles the browser's Media APIs and WebRTC logic.

**Key Functions:**

#### Media Management
- `getLocalStream()`: Requests camera/mic access (`navigator.mediaDevices.getUserMedia`). Creates a fallback "placeholder" stream if no devices are found.
- `toggleScreenSharing()`: Captures screen (`getDisplayMedia`), utilizes `replaceTrack` to seamlessly switch video/audio tracks in active connections without dropping the call.
- `toggleAudio()` / `toggleVideo()`: Mutes/unmutes local tracks.

#### WebRTC Core
- `createPeerConnection(peerId)`: Creates a new `RTCPeerConnection` configuration with STUN servers (google). Sets up event listeners for ICE candidates and incoming tracks.
- `createOffer(peerId)`: The "caller" creates an offer description (SDP) and sends it via the server.
- `handleOffer(senderId, offer)`: The "callee" receives an offer, sets it as remote description, creates an answer, and sends it back.
- `handleAnswer(...)`: The "caller" receives the answer and finalizes the connection.
- `handleIceCandidate(...)`: Exchanges network route information (IPs/Ports) to establish the direct link.

#### Utility
- `requestWakeLock()`: Prevents the device screen from sleeping to maintain the connection.
- `togglePip()`: Puts the local video into a floating window.

### 4. `public/sw.js` (Service Worker)
Enables Progressive Web App (PWA) capabilities.
- Caches core assets (`index.html`, `script.js`, etc.) so the app can load faster or work offline (to an extent).

## Common User Flows

### Scenario A: Joining a Room
1. **User A** clicks "Join Room".
2. `getLocalStream()` initializes camera.
3. Socket emits `join-room`. Server sees room is empty -> User A is **Host**.
4. **User B** clicks "Join Room".
5. Socket emits `join-room`. Server sees room exists -> emits `join-request` to Host (User A).
6. **User A** gets a browser popup (`confirm()`). If accepted -> emits `accept-user`.
7. **User B** receives `join-approved`.

### Scenario B: Establishing Video (The Handshake)
Once User B is approved:
1. User B (The "Joiner") calls `createOffer()` for User A.
2. **User B** sets local description -> sends `offer` via server.
3. **User A** receives `offer` -> `handleOffer()`.
4. **User A** sets remote description -> creates `answer` -> sets local description -> sends `answer`.
5. **User B** receives `answer` -> `handleAnswer()`.
6. Both users exchange `ice-candidate` events continuously until a direct path is found.
7. `ontrack` event fires on both sides -> Video appears!

### Scenario C: Screen Sharing
1. User clicks Share button -> `toggleScreenSharing()`.
2. Browser asks to select screen/window.
3. `getDisplayMedia` returns a new stream.
4. App iterates through all active `peerConnections`.
5. Calls `sender.replaceTrack()` to swap the Camera Video Track with the Screen Video Track.
6. **Audio Magic**: If "Share System Audio" is checked, it also swaps the Mic Audio Track with System Audio Track.
7. UI updates style (`aspect-ratio: auto`) to show full screen.
