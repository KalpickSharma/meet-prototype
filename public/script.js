/**
 * ============================================
 * WebRTC Client for 3-Person Video Calls
 * ============================================
 * 
 * This script handles:
 * 1. Getting user's camera/microphone
 * 2. Connecting to the signaling server via Socket.IO
 * 3. Creating peer-to-peer WebRTC connections
 * 4. Exchanging offers, answers, and ICE candidates
 * 5. Displaying local and remote video streams
 * 
 * Architecture: Full Mesh
 * - Each peer connects directly to every other peer
 * - For 3 users: 3 peer connections total (A-B, A-C, B-C)
 */

// ============================================
// Configuration
// ============================================

// STUN servers help peers discover their public IP addresses
// These are free public STUN servers from Google
const ICE_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Room ID - for this prototype, everyone joins the same room
const ROOM_ID = 'main-room';

// ============================================
// Global Variables
// ============================================

let socket = null;              // Socket.IO connection
let localStream = null;         // Our camera/microphone stream
let peerConnections = {};       // Object to store RTCPeerConnection for each peer
let screenStream = null;        // Stream for screen sharing
let isScreenSharing = false;    // Flag for screen sharing state
let wakeLock = null;            // To keep the screen on during calls
let audioContext = null;        // AudioContext for mixing streams
let mixedStreamDestination = null; // Destination for mixed audio
// Key: peerId, Value: RTCPeerConnection

// --- Screen Recording ---
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimerInterval = null;

// --- Virtual Background ---
let selfieSegmentation = null;
let bgCanvas = null;
let bgCtx = null;
let bgVideoElement = null;
let bgAnimationId = null;
let bgProcessedStream = null;
let bgOriginalTrack = null;
let bgConfig = { type: 'none', color: '#6c5ce7', imageSrc: null, imageEl: null };

// ============================================
// DOM Elements
// ============================================

const videoGrid = document.getElementById('video-grid');
const statusText = document.getElementById('status-text');
const joinBtn = document.getElementById('join-btn');
const muteBtn = document.getElementById('mute-btn');
const videoBtn = document.getElementById('video-btn');
const shareBtn = document.getElementById('share-btn');
const recordBtn = document.getElementById('record-btn');
const bgBtn = document.getElementById('bg-btn');
const pipBtn = document.getElementById('pip-btn');
const leaveBtn = document.getElementById('leave-btn');

// ============================================
// Utility Functions
// ============================================

/**
 * Update the status display
 * @param {string} message - Status message to display
 * @param {string} type - 'normal', 'success', or 'error'
 */
function updateStatus(message, type = 'normal') {
    statusText.textContent = message;
    statusText.className = type;
    console.log(`[STATUS] ${message}`);
}

/**
 * Create a video container element
 * @param {string} id - Unique ID for the video element
 * @param {string} label - Label to display (e.g., "You" or "Peer 1")
 * @param {boolean} isLocal - Whether this is the local video
 * @returns {HTMLElement} The video container element
 */
function createVideoContainer(id, label, isLocal = false) {
    const container = document.createElement('div');
    container.className = `video-container ${isLocal ? 'local' : ''}`;
    container.id = `container-${id}`;

    const video = document.createElement('video');
    video.id = `video-${id}`;
    video.autoplay = true;
    video.playsInline = true;
    // Mute local video to prevent audio feedback
    if (isLocal) {
        video.muted = true;
    }

    const labelDiv = document.createElement('div');
    labelDiv.className = 'video-label';
    labelDiv.textContent = label;

    container.appendChild(video);
    container.appendChild(labelDiv);

    return container;
}

/**
 * Add a video stream to the grid
 * @param {string} id - Unique ID for this video
 * @param {MediaStream} stream - The media stream to display
 * @param {string} label - Label for the video
 * @param {boolean} isLocal - Whether this is the local video
 */
function addVideoStream(id, stream, label, isLocal = false) {
    // Check if video already exists
    if (document.getElementById(`container-${id}`)) {
        console.log(`[VIDEO] Video for ${id} already exists`);
        return;
    }

    const container = createVideoContainer(id, label, isLocal);
    videoGrid.appendChild(container);

    const video = document.getElementById(`video-${id}`);
    video.srcObject = stream;

    console.log(`[VIDEO] Added video for: ${id}`);
    updateGridLayout();
}

/**
 * Remove a video from the grid
 * @param {string} id - ID of the video to remove
 */
function removeVideo(id) {
    const container = document.getElementById(`container-${id}`);
    if (container) {
        container.remove();
        console.log(`[VIDEO] Removed video for: ${id}`);
        updateGridLayout();
    }
}

// ============================================
// Media Functions
// ============================================

/**
 * Get user's camera and microphone stream
 * Tries multiple fallbacks if devices aren't available
 * @returns {Promise<MediaStream>} The local media stream
 */
async function getLocalStream() {
    // Try different combinations of media constraints
    const constraints = [
        { video: true, audio: true },    // Ideal: both video and audio
        { video: true, audio: false },   // Fallback 1: video only
        { video: false, audio: true },   // Fallback 2: audio only
    ];

    for (const constraint of constraints) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraint);
            console.log(`[MEDIA] Got stream with: video=${constraint.video}, audio=${constraint.audio}`);
            return stream;
        } catch (error) {
            console.warn(`[MEDIA] Failed with constraints:`, constraint, error.message);
        }
    }

    // If all fails, create a placeholder stream (for testing without devices)
    console.warn('[MEDIA] No camera/mic available. Creating placeholder stream for testing.');

    // Create a canvas-based placeholder video stream
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');

    // Draw a placeholder image
    function drawPlaceholder() {
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#00d4ff';
        ctx.font = '24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('No Camera Available', canvas.width / 2, canvas.height / 2 - 20);
        ctx.fillStyle = '#888';
        ctx.font = '16px Arial';
        ctx.fillText('(Placeholder for testing)', canvas.width / 2, canvas.height / 2 + 20);
    }

    drawPlaceholder();

    // Create a stream from the canvas
    const placeholderStream = canvas.captureStream(1); // 1 FPS for placeholder

    // Add a silent audio track
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const destination = audioContext.createMediaStreamDestination();
    oscillator.connect(destination);
    oscillator.frequency.value = 0; // Silent
    oscillator.start();

    // Combine video and audio tracks
    placeholderStream.addTrack(destination.stream.getAudioTracks()[0]);

    return placeholderStream;
}

/**
 * Mixes microphone audio with system audio
 * @param {MediaStream} micStream - The microphone stream
 * @param {MediaStream} systemStream - The system audio stream
 * @returns {MediaStreamTrack} The mixed audio track
 */
function createMixedAudioStream(micStream, systemStream) {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Create destination if it doesn't exist
    if (!mixedStreamDestination) {
        mixedStreamDestination = audioContext.createMediaStreamDestination();
    }

    // Add microphone to mix
    if (micStream && micStream.getAudioTracks().length > 0) {
        const micSource = audioContext.createMediaStreamSource(micStream);
        micSource.connect(mixedStreamDestination);
    }

    // Add system audio to mix
    if (systemStream && systemStream.getAudioTracks().length > 0) {
        const systemSource = audioContext.createMediaStreamSource(systemStream);
        systemSource.connect(mixedStreamDestination);
    }

    return mixedStreamDestination.stream.getAudioTracks()[0];
}

/**
 * Updates the video grid layout based on participant count
 */
function updateGridLayout() {
    const videoContainers = document.querySelectorAll('.video-container');
    const count = videoContainers.length;

    // Reset grid classes
    videoGrid.className = '';

    if (isScreenSharing) {
        videoGrid.classList.add('gallery-sharing');
    } else {
        if (count === 1) videoGrid.classList.add('gallery-1');
        else if (count === 2) videoGrid.classList.add('gallery-2');
        else if (count <= 4) videoGrid.classList.add('gallery-4');
        else videoGrid.classList.add('gallery-many');
    }
}

/**
 * Handle Screen Sharing
 */
async function toggleScreenSharing() {
    try {
        if (!isScreenSharing) {
            updateStatus('Starting screen share...');
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true // Optional: system audio
            });

            // Handle when user clicks "Stop Sharing" on browser UI
            screenStream.getVideoTracks()[0].onended = () => {
                if (isScreenSharing) toggleScreenSharing();
            };

            const screenTrack = screenStream.getVideoTracks()[0];
            const screenAudioTrack = screenStream.getAudioTracks()[0];

            // Replace tracks in all peer connections
            for (const peerId in peerConnections) {
                const senders = peerConnections[peerId].getSenders();

                // Replace video track
                const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(screenTrack);
                }

                // Replace audio track with mixed audio if screen share has audio
                if (screenAudioTrack) {
                    const mixedAudioTrack = createMixedAudioStream(localStream, screenStream);

                    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                    if (audioSender) {
                        audioSender.replaceTrack(mixedAudioTrack);
                        console.log(`[RTC] Replaced audio track with mixed audio for ${peerId}`);
                    }
                }
            }

            // Update local preview and container
            const localContainer = document.getElementById('container-local');
            const localVideo = document.getElementById('video-local');
            if (localContainer) {
                localContainer.classList.add('sharing-screen');
            }
            if (localVideo) {
                localVideo.srcObject = screenStream;
            }

            // Update grid layout for sharing mode
            updateGridLayout();

            isScreenSharing = true;
            shareBtn.classList.add('toggle-off');
            shareBtn.innerHTML = '<i class="fas fa-stop-circle"></i>';
            videoBtn.disabled = true; // Disable camera toggle while sharing screen
            updateStatus('Sharing screen', 'success');
        } else {
            updateStatus('Stopping screen share...');

            // Stop screen tracks
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;

            const cameraTrack = localStream.getVideoTracks()[0];
            const micTrack = localStream.getAudioTracks()[0];

            // Replace back with camera and mic tracks in all peer connections
            for (const peerId in peerConnections) {
                const senders = peerConnections[peerId].getSenders();

                // Restore video track
                const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    videoSender.replaceTrack(cameraTrack);
                }

                // Restore audio track
                const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                if (audioSender && micTrack) {
                    audioSender.replaceTrack(micTrack);
                    console.log(`[RTC] Restored mic audio track for ${peerId}`);
                }
            }

            // Restore local preview and container
            const localContainer = document.getElementById('container-local');
            const localVideo = document.getElementById('video-local');
            if (localContainer) {
                localContainer.classList.remove('sharing-screen');
            }
            if (localVideo) {
                localVideo.srcObject = localStream;
            }

            isScreenSharing = false;
            shareBtn.classList.remove('toggle-off');
            shareBtn.innerHTML = '<i class="fas fa-desktop"></i>';
            videoBtn.disabled = false;
            updateStatus('Stopped screen share');

            // Clean up AudioContext if used
            if (audioContext && audioContext.state !== 'closed') {
                // We keep it open for future but could suspend
                // audioContext.suspend(); 
            }

            // Update grid layout
            updateGridLayout();
        }
    } catch (error) {
        console.error('[ERROR] Screen share failed:', error);
        updateStatus('Screen share cancelled', 'error');
    }
}

/**
 * Handle Picture-in-Picture for the first found remote video or local
 */
async function togglePip() {
    try {
        const localVideo = document.getElementById('video-local');
        if (!localVideo) return;

        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else {
            if (localVideo.readyState >= 2) {
                await localVideo.requestPictureInPicture();
            } else {
                updateStatus('Video not ready for PiP', 'error');
            }
        }
    } catch (error) {
        console.error('[ERROR] PiP failed:', error);
    }
}

/**
 * Wake Lock to keep camera/audio active in background (mobile/high-perf)
 */
async function requestWakeLock() {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[WAKE LOCK] Screen Wake Lock is active');
        } catch (err) {
            console.error(`[WAKE LOCK] ${err.name}, ${err.message}`);
        }
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release().then(() => {
            wakeLock = null;
            console.log('[WAKE LOCK] Released');
        });
    }
}

// ============================================
// WebRTC Functions
// ============================================

/**
 * Create a new RTCPeerConnection for a specific peer
 * @param {string} peerId - The ID of the remote peer
 * @returns {RTCPeerConnection} The peer connection object
 */
function createPeerConnection(peerId) {
    console.log(`[RTC] Creating peer connection for: ${peerId}`);

    const peerConnection = new RTCPeerConnection(ICE_SERVERS);

    // Store the connection
    peerConnections[peerId] = peerConnection;

    // Add our local stream tracks to the connection
    // This allows the remote peer to receive our audio/video
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
        console.log(`[RTC] Added local track: ${track.kind}`);
    });

    /**
     * Handle ICE candidates
     * ICE candidates are potential connection paths
     * We send each candidate to the remote peer via signaling server
     */
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log(`[ICE] Sending ICE candidate to: ${peerId}`);
            socket.emit('ice-candidate', {
                target: peerId,
                candidate: event.candidate
            });
        }
    };

    /**
     * Handle connection state changes
     * Useful for debugging connection issues
     */
    peerConnection.onconnectionstatechange = () => {
        console.log(`[RTC] Connection state with ${peerId}: ${peerConnection.connectionState}`);
        if (peerConnection.connectionState === 'connected') {
            updateStatus(`Connected to peers`, 'success');
        } else if (peerConnection.connectionState === 'failed') {
            updateStatus(`Connection failed with a peer`, 'error');
        }
    };

    /**
     * Handle incoming remote tracks
     * When the remote peer's audio/video arrives, display it
     */
    peerConnection.ontrack = (event) => {
        console.log(`[RTC] Received remote track from: ${peerId}`);

        // event.streams[0] contains the remote media stream
        const remoteStream = event.streams[0];

        // Count existing remote videos to generate label
        const remoteCount = Object.keys(peerConnections).indexOf(peerId) + 1;
        addVideoStream(peerId, remoteStream, `Peer ${remoteCount}`);
    };

    return peerConnection;
}

/**
 * Create and send an offer to a peer
 * The initiator (newer user) creates offers to existing users
 * @param {string} peerId - The ID of the peer to send offer to
 */
async function createOffer(peerId) {
    console.log(`[RTC] Creating offer for: ${peerId}`);

    const peerConnection = createPeerConnection(peerId);

    try {
        // Create the SDP offer
        const offer = await peerConnection.createOffer();

        // Set as our local description
        await peerConnection.setLocalDescription(offer);

        // Send offer to the remote peer via signaling server
        socket.emit('offer', {
            target: peerId,
            offer: offer
        });

        console.log(`[RTC] Sent offer to: ${peerId}`);
    } catch (error) {
        console.error(`[RTC] Error creating offer:`, error);
    }
}

/**
 * Handle an incoming offer and create an answer
 * @param {string} senderId - The ID of the peer who sent the offer
 * @param {RTCSessionDescriptionInit} offer - The SDP offer
 */
async function handleOffer(senderId, offer) {
    console.log(`[RTC] Received offer from: ${senderId}`);

    const peerConnection = createPeerConnection(senderId);

    try {
        // Set the remote description (the offer)
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

        // Create an answer
        const answer = await peerConnection.createAnswer();

        // Set as our local description
        await peerConnection.setLocalDescription(answer);

        // Send answer back to the peer who sent the offer
        socket.emit('answer', {
            target: senderId,
            answer: answer
        });

        console.log(`[RTC] Sent answer to: ${senderId}`);
    } catch (error) {
        console.error(`[RTC] Error handling offer:`, error);
    }
}

/**
 * Handle an incoming answer to our offer
 * @param {string} senderId - The ID of the peer who sent the answer
 * @param {RTCSessionDescriptionInit} answer - The SDP answer
 */
async function handleAnswer(senderId, answer) {
    console.log(`[RTC] Received answer from: ${senderId}`);

    const peerConnection = peerConnections[senderId];
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log(`[RTC] Set remote description for: ${senderId}`);
        } catch (error) {
            console.error(`[RTC] Error setting remote description:`, error);
        }
    }
}

/**
 * Handle an incoming ICE candidate
 * @param {string} senderId - The ID of the peer who sent the candidate
 * @param {RTCIceCandidateInit} candidate - The ICE candidate
 */
async function handleIceCandidate(senderId, candidate) {
    console.log(`[ICE] Received ICE candidate from: ${senderId}`);

    const peerConnection = peerConnections[senderId];
    if (peerConnection) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`[ICE] Added ICE candidate from: ${senderId}`);
        } catch (error) {
            console.error(`[ICE] Error adding ICE candidate:`, error);
        }
    }
}

/**
 * Close a peer connection and clean up
 * @param {string} peerId - The ID of the peer to disconnect from
 */
function closePeerConnection(peerId) {
    const peerConnection = peerConnections[peerId];
    if (peerConnection) {
        peerConnection.close();
        delete peerConnections[peerId];
        removeVideo(peerId);
        console.log(`[RTC] Closed connection with: ${peerId}`);
    }
}

// ============================================
// Socket.IO Event Handlers
// ============================================

/**
 * Initialize Socket.IO connection and set up event handlers
 */
function initializeSocket() {
    socket = io();

    /**
     * Waiting Room: Host receives join request
     */
    socket.on('join-request', ({ sender }) => {
        console.log(`[SOCKET] Join request from: ${sender}`);
        const confirmed = confirm(`A user (ID: ${sender}) wants to join the room. Allow them?`);
        if (confirmed) {
            socket.emit('accept-user', { targetId: sender });
        } else {
            socket.emit('reject-user', { targetId: sender });
        }
    });

    /**
     * Waiting Room: Joiner is waiting
     */
    socket.on('waiting-for-host', () => {
        updateStatus('Waiting for host to let you in...', 'normal');
    });

    /**
     * Waiting Room: Joiner is approved
     */
    socket.on('join-approved', ({ existingUsers }) => {
        console.log(`[SOCKET] Join approved! Existing users:`, existingUsers);
        updateStatus('Join approved! Connecting...', 'success');

        // Now connect to existing users
        existingUsers.forEach(userId => {
            createOffer(userId);
        });

        muteBtn.disabled = false;
        videoBtn.disabled = false;
        shareBtn.disabled = false;
        recordBtn.disabled = false;
        bgBtn.disabled = false;
        pipBtn.disabled = false;
        leaveBtn.disabled = false;
    });

    /**
     * Waiting Room: Joiner is rejected
     */
    socket.on('join-rejected', () => {
        updateStatus('Join request was rejected by host.', 'error');
        leaveRoom();
    });

    /**
     * When we join as host, we are already in the room
     */
    socket.on('joined-as-host', () => {
        updateStatus('Joined as host. Waiting for others...', 'success');
        muteBtn.disabled = false;
        videoBtn.disabled = false;
        shareBtn.disabled = false;
        recordBtn.disabled = false;
        bgBtn.disabled = false;
        pipBtn.disabled = false;
        leaveBtn.disabled = false;
    });

    /**
     * Handle incoming peer signaling
     */
    socket.on('user-joined', (userId) => {
        console.log(`[SOCKET] New user joined: ${userId}`);
        updateStatus(`New peer connecting...`);
    });

    socket.on('offer', ({ sender, offer }) => {
        handleOffer(sender, offer);
    });

    socket.on('answer', ({ sender, answer }) => {
        handleAnswer(sender, answer);
    });

    socket.on('ice-candidate', ({ sender, candidate }) => {
        handleIceCandidate(sender, candidate);
    });

    socket.on('user-left', (userId) => {
        console.log(`[SOCKET] User left: ${userId}`);
        closePeerConnection(userId);
        updateStatus('A user left the call');
    });

    console.log('[SOCKET] Socket initialized');
}

// ============================================
// Room Management
// ============================================

/**
 * Join the video call room
 */
async function joinRoom() {
    try {
        updateStatus('Getting camera and microphone...');
        joinBtn.disabled = true;

        // Get local media stream
        localStream = await getLocalStream();

        // Display local video
        addVideoStream('local', localStream, 'You (Local)', true);

        // Initialize socket connection
        initializeSocket();

        // Join the room
        updateStatus('Requesting to join room...');
        socket.emit('join-room', ROOM_ID);

        // Request Wake Lock to keep connection active
        requestWakeLock();

        // Success state is now handled by joined-as-host or join-approved events

    } catch (error) {
        console.error('[ERROR] Failed to join room:', error);
        updateStatus(`Error: ${error.message}`, 'error');
        joinBtn.disabled = false;
    }
}

/**
 * Leave the video call room
 */
function leaveRoom() {
    // Close all peer connections
    Object.keys(peerConnections).forEach(peerId => {
        closePeerConnection(peerId);
    });

    // Stop local media tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }

    // Disconnect socket
    if (socket) {
        socket.disconnect();
        socket = null;
    }

    // Clear video grid
    videoGrid.innerHTML = '';

    // Reset UI
    updateStatus('Left the room. Ready to rejoin.');
    joinBtn.disabled = false;
    muteBtn.disabled = true;
    videoBtn.disabled = true;
    shareBtn.disabled = true;
    recordBtn.disabled = true;
    bgBtn.disabled = true;
    pipBtn.disabled = true;
    leaveBtn.disabled = true;

    // Release Wake Lock
    releaseWakeLock();

    // Stop recording if active
    if (isRecording) stopRecording();

    // Stop virtual background if active
    stopVirtualBackground();

    // Reset button text/icons
    muteBtn.innerHTML = '<i class="fas fa-microphone"></i>';
    videoBtn.innerHTML = '<i class="fas fa-video"></i>';
    muteBtn.classList.remove('toggle-off');
    videoBtn.classList.remove('toggle-off');
    recordBtn.classList.remove('recording');
    bgBtn.classList.remove('bg-active');

    console.log('[ROOM] Left the room');
}

/**
 * Toggle local audio track
 */
function toggleAudio() {
    if (!localStream) return;

    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        muteBtn.innerHTML = audioTrack.enabled ? '<i class="fas fa-microphone"></i>' : '<i class="fas fa-microphone-slash"></i>';
        if (!audioTrack.enabled) {
            muteBtn.classList.add('toggle-off');
        } else {
            muteBtn.classList.remove('toggle-off');
        }
        console.log(`[MEDIA] Audio ${audioTrack.enabled ? 'enabled' : 'disabled'}`);
    }
}

/**
 * Toggle local video track
 */
function toggleVideo() {
    if (!localStream) return;

    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        videoBtn.innerHTML = videoTrack.enabled ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
        if (!videoTrack.enabled) {
            videoBtn.classList.add('toggle-off');
        } else {
            videoBtn.classList.remove('toggle-off');
        }
        console.log(`[MEDIA] Video ${videoTrack.enabled ? 'enabled' : 'disabled'}`);
    }
}

// ============================================
// Screen Recording
// ============================================

function startRecording() {
    try {
        recordedChunks = [];
        // Capture the video grid as a canvas stream
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        const canvasStream = canvas.captureStream(30);

        // Mix all audio from peer connections + local
        const recAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const recDest = recAudioCtx.createMediaStreamDestination();

        if (localStream && localStream.getAudioTracks().length > 0) {
            recAudioCtx.createMediaStreamSource(localStream).connect(recDest);
        }
        // Add remote audio
        document.querySelectorAll('#video-grid video').forEach(v => {
            if (v.srcObject && !v.muted && v.srcObject.getAudioTracks().length > 0) {
                try { recAudioCtx.createMediaStreamSource(v.srcObject).connect(recDest); } catch(e) {}
            }
        });

        recDest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));

        // Draw all videos onto canvas
        function drawFrame() {
            ctx.fillStyle = '#0b0b1a';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const videos = document.querySelectorAll('#video-grid video');
            const count = videos.length;
            if (count === 0) { if (isRecording) requestAnimationFrame(drawFrame); return; }
            const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
            const rows = Math.ceil(count / cols);
            const w = canvas.width / cols;
            const h = canvas.height / rows;
            videos.forEach((v, i) => {
                const x = (i % cols) * w;
                const y = Math.floor(i / cols) * h;
                try { ctx.drawImage(v, x + 2, y + 2, w - 4, h - 4); } catch(e) {}
            });
            if (isRecording) requestAnimationFrame(drawFrame);
        }

        mediaRecorder = new MediaRecorder(canvasStream, {
            mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
                ? 'video/webm;codecs=vp9,opus' : 'video/webm'
        });

        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `meeting-recording-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`;
            a.click();
            URL.revokeObjectURL(url);
            recAudioCtx.close();
        };

        mediaRecorder.start(1000);
        isRecording = true;
        recordingStartTime = Date.now();
        drawFrame();

        // Timer
        const indicator = document.getElementById('recording-indicator');
        const timerEl = document.getElementById('rec-timer');
        indicator.classList.add('active');
        recordingTimerInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            timerEl.textContent = `REC ${m}:${s}`;
        }, 1000);

        recordBtn.classList.add('recording');
        recordBtn.innerHTML = '<i class="fas fa-stop"></i>';
        updateStatus('Recording started', 'success');
        console.log('[REC] Recording started');
    } catch (err) {
        console.error('[REC] Failed to start:', err);
        updateStatus('Recording failed to start', 'error');
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    isRecording = false;
    clearInterval(recordingTimerInterval);
    document.getElementById('recording-indicator').classList.remove('active');
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = '<i class="fas fa-circle"></i>';
    updateStatus('Recording saved');
    console.log('[REC] Recording stopped');
}

function toggleRecording() {
    if (isRecording) stopRecording();
    else startRecording();
}

// ============================================
// Virtual Background
// ============================================

async function initSegmentation() {
    if (selfieSegmentation) return;
    try {
        selfieSegmentation = new SelfieSegmentation({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`
        });
        selfieSegmentation.setOptions({ modelSelection: 1 });
        selfieSegmentation.onResults(onSegmentationResults);
        console.log('[BG] Segmentation model initialized');
    } catch (err) {
        console.error('[BG] Failed to init segmentation:', err);
        updateStatus('Background effect unavailable', 'error');
    }
}

function onSegmentationResults(results) {
    if (!bgCtx || !bgCanvas) return;
    bgCtx.save();
    bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);

    // Draw the segmentation mask
    bgCtx.drawImage(results.segmentationMask, 0, 0, bgCanvas.width, bgCanvas.height);

    // Where the person IS, keep the camera image
    bgCtx.globalCompositeOperation = 'source-in';
    bgCtx.drawImage(results.image, 0, 0, bgCanvas.width, bgCanvas.height);

    // Now draw background behind the person
    bgCtx.globalCompositeOperation = 'destination-over';
    if (bgConfig.type === 'blur') {
        bgCtx.filter = 'blur(15px)';
        bgCtx.drawImage(results.image, 0, 0, bgCanvas.width, bgCanvas.height);
        bgCtx.filter = 'none';
    } else if (bgConfig.type === 'color') {
        bgCtx.fillStyle = bgConfig.color;
        bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);
    } else if (bgConfig.type === 'image' && bgConfig.imageEl) {
        bgCtx.drawImage(bgConfig.imageEl, 0, 0, bgCanvas.width, bgCanvas.height);
    }
    bgCtx.restore();
}

async function applyVirtualBackground() {
    if (!localStream) return;
    await initSegmentation();
    if (!selfieSegmentation) return;

    // Create offscreen canvas
    bgCanvas = document.createElement('canvas');
    bgCanvas.width = 640;
    bgCanvas.height = 480;
    bgCtx = bgCanvas.getContext('2d');

    // Create a hidden video element to feed frames
    bgVideoElement = document.createElement('video');
    bgVideoElement.srcObject = localStream;
    bgVideoElement.muted = true;
    bgVideoElement.playsInline = true;
    bgVideoElement.play();

    // Store original track
    bgOriginalTrack = localStream.getVideoTracks()[0];

    // Preload image if needed
    if (bgConfig.type === 'image' && bgConfig.imageSrc) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = bgConfig.imageSrc;
        await new Promise((res) => { img.onload = res; img.onerror = res; });
        bgConfig.imageEl = img;
    }

    // Process frames
    async function processFrame() {
        if (!bgVideoElement || bgVideoElement.paused || bgVideoElement.ended) return;
        await selfieSegmentation.send({ image: bgVideoElement });
        bgAnimationId = requestAnimationFrame(processFrame);
    }

    bgVideoElement.addEventListener('loadeddata', () => { processFrame(); });
    if (bgVideoElement.readyState >= 2) processFrame();

    // Create stream from canvas and replace tracks
    bgProcessedStream = bgCanvas.captureStream(30);
    const processedTrack = bgProcessedStream.getVideoTracks()[0];

    // Replace in local preview
    const localVideo = document.getElementById('video-local');
    if (localVideo) {
        const newStream = new MediaStream([processedTrack, ...localStream.getAudioTracks()]);
        localVideo.srcObject = newStream;
    }

    // Replace in all peer connections
    for (const peerId in peerConnections) {
        const senders = peerConnections[peerId].getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) videoSender.replaceTrack(processedTrack);
    }

    bgBtn.classList.add('bg-active');
    updateStatus('Virtual background applied', 'success');
    console.log('[BG] Virtual background applied:', bgConfig.type);
}

function stopVirtualBackground() {
    if (bgAnimationId) cancelAnimationFrame(bgAnimationId);
    bgAnimationId = null;
    if (bgVideoElement) { bgVideoElement.pause(); bgVideoElement.srcObject = null; bgVideoElement = null; }
    if (bgProcessedStream) { bgProcessedStream.getTracks().forEach(t => t.stop()); bgProcessedStream = null; }

    // Restore original track
    if (bgOriginalTrack && localStream) {
        const localVideo = document.getElementById('video-local');
        if (localVideo) localVideo.srcObject = localStream;
        for (const peerId in peerConnections) {
            const senders = peerConnections[peerId].getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            if (videoSender) videoSender.replaceTrack(bgOriginalTrack);
        }
    }
    bgOriginalTrack = null;
    bgCanvas = null;
    bgCtx = null;
    bgBtn.classList.remove('bg-active');
    bgConfig.type = 'none';
    console.log('[BG] Virtual background removed');
}

// ============================================
// Background Modal Logic
// ============================================

function openBgModal() {
    document.getElementById('bg-modal-overlay').classList.add('active');
}

function closeBgModal() {
    document.getElementById('bg-modal-overlay').classList.remove('active');
}

function initBgModal() {
    const overlay = document.getElementById('bg-modal-overlay');
    const options = document.querySelectorAll('.bg-option');
    const colorRow = document.getElementById('bg-color-picker-row');
    const colorPicker = document.getElementById('bg-color-picker');
    let pendingBg = { type: 'none', color: '#6c5ce7', imageSrc: null };

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBgModal(); });

    options.forEach(opt => {
        opt.addEventListener('click', () => {
            options.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            pendingBg.type = opt.dataset.bg;
            if (opt.dataset.bg === 'image') pendingBg.imageSrc = opt.dataset.src;
            colorRow.style.display = opt.dataset.bg === 'color' ? 'block' : 'none';
        });
    });

    colorPicker.addEventListener('input', (e) => {
        pendingBg.color = e.target.value;
        document.querySelector('.bg-option-color').style.background = e.target.value;
    });

    document.getElementById('bg-cancel-btn').addEventListener('click', closeBgModal);

    document.getElementById('bg-apply-btn').addEventListener('click', () => {
        closeBgModal();
        if (pendingBg.type === 'none') {
            stopVirtualBackground();
            updateStatus('Background removed');
        } else {
            bgConfig.type = pendingBg.type;
            bgConfig.color = pendingBg.color;
            bgConfig.imageSrc = pendingBg.imageSrc;
            // Stop existing bg first, then apply new
            if (bgAnimationId) stopVirtualBackground();
            applyVirtualBackground();
        }
    });
}

// ============================================
// Event Listeners
// ============================================

joinBtn.addEventListener('click', joinRoom);
muteBtn.addEventListener('click', toggleAudio);
videoBtn.addEventListener('click', toggleVideo);
shareBtn.addEventListener('click', toggleScreenSharing);
recordBtn.addEventListener('click', toggleRecording);
bgBtn.addEventListener('click', openBgModal);
pipBtn.addEventListener('click', togglePip);
leaveBtn.addEventListener('click', leaveRoom);

// Handle page unload - clean up connections
window.addEventListener('beforeunload', () => {
    leaveRoom();
});

// Initialize background modal
initBgModal();

// Log when script loads
console.log('[INIT] WebRTC client script loaded');
console.log('[INFO] Click "Join Room" to start the call');
console.log('[INFO] Open this page in 3 tabs to test a 3-person call');
