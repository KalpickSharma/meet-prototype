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
// Key: peerId, Value: RTCPeerConnection

// ============================================
// DOM Elements
// ============================================

const videoGrid = document.getElementById('video-grid');
const statusText = document.getElementById('status-text');
const joinBtn = document.getElementById('join-btn');
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
     * When we join a room, we receive a list of existing users
     * We need to create offers to all of them
     */
    socket.on('existing-users', (users) => {
        console.log(`[SOCKET] Existing users in room:`, users);
        users.forEach(userId => {
            // Create an offer for each existing user
            createOffer(userId);
        });
    });

    /**
     * When a new user joins the room
     * We don't need to do anything - they will send us an offer
     */
    socket.on('user-joined', (userId) => {
        console.log(`[SOCKET] New user joined: ${userId}`);
        updateStatus(`User joined. Waiting for connection...`);
    });

    /**
     * Handle incoming offers
     */
    socket.on('offer', ({ sender, offer }) => {
        handleOffer(sender, offer);
    });

    /**
     * Handle incoming answers
     */
    socket.on('answer', ({ sender, answer }) => {
        handleAnswer(sender, answer);
    });

    /**
     * Handle incoming ICE candidates
     */
    socket.on('ice-candidate', ({ sender, candidate }) => {
        handleIceCandidate(sender, candidate);
    });

    /**
     * When a user leaves the room
     */
    socket.on('user-left', (userId) => {
        console.log(`[SOCKET] User left: ${userId}`);
        closePeerConnection(userId);
        updateStatus('A user left the call');
    });

    /**
     * When room is full (3 users already)
     */
    socket.on('room-full', () => {
        updateStatus('Room is full (max 3 users)', 'error');
        leaveRoom();
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
        updateStatus('Joining room...');
        socket.emit('join-room', ROOM_ID);

        updateStatus('In room. Waiting for others...', 'success');
        leaveBtn.disabled = false;

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
    leaveBtn.disabled = true;

    console.log('[ROOM] Left the room');
}

// ============================================
// Event Listeners
// ============================================

joinBtn.addEventListener('click', joinRoom);
leaveBtn.addEventListener('click', leaveRoom);

// Handle page unload - clean up connections
window.addEventListener('beforeunload', () => {
    leaveRoom();
});

// Log when script loads
console.log('[INIT] WebRTC client script loaded');
console.log('[INFO] Click "Join Room" to start the call');
console.log('[INFO] Open this page in 3 tabs to test a 3-person call');
