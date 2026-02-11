/*
 * ============================================
 * WebRTC Signaling Server - Cloud Version
 * ============================================
 * 
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// IMPORTANT: Use the PORT environment variable provided by the cloud platform
const PORT = process.env.PORT || 3000;
const MAX_USERS_PER_ROOM = 5;

const rooms = {};

io.on('connection', (socket) => {
    console.log(`[CONNECT] User connected: ${socket.id}`);

    socket.on('join-room', (roomId) => {
        if (!rooms[roomId]) {
            // First user joins directly and becomes host
            rooms[roomId] = { host: socket.id, users: {} };
            rooms[roomId].users[socket.id] = { id: socket.id };
            socket.join(roomId);
            socket.roomId = roomId;
            console.log(`[HOST] User ${socket.id} started room ${roomId}`);
            socket.emit('joined-as-host');
        } else {
            // Room already exists, ask the host for permission
            const hostId = rooms[roomId].host;
            console.log(`[WAITING] User ${socket.id} requesting to join room ${roomId} (Host: ${hostId})`);
            io.to(hostId).emit('join-request', { sender: socket.id });
            socket.emit('waiting-for-host');
        }
    });

    socket.on('accept-user', ({ targetId }) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId] || rooms[roomId].host !== socket.id) return;

        console.log(`[ACCEPTED] Host ${socket.id} accepted user ${targetId}`);

        const existingUsers = Object.keys(rooms[roomId].users);
        rooms[roomId].users[targetId] = { id: targetId };

        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) {
            targetSocket.join(roomId);
            targetSocket.roomId = roomId;
            targetSocket.emit('join-approved', { existingUsers });
            socket.to(roomId).emit('user-joined', targetId);
        }
    });

    socket.on('reject-user', ({ targetId }) => {
        console.log(`[REJECTED] Host ${socket.id} rejected user ${targetId}`);
        io.to(targetId).emit('join-rejected');
    });

    socket.on('offer', ({ target, offer }) => {
        io.to(target).emit('offer', { sender: socket.id, offer });
    });

    socket.on('answer', ({ target, answer }) => {
        io.to(target).emit('answer', { sender: socket.id, answer });
    });

    socket.on('ice-candidate', ({ target, candidate }) => {
        io.to(target).emit('ice-candidate', { sender: socket.id, candidate });
    });

    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (roomId && rooms[roomId]) {
            delete rooms[roomId].users[socket.id];
            socket.to(roomId).emit('user-left', socket.id);

            // If host leaves, assign a new host or close room
            if (rooms[roomId].host === socket.id) {
                const remainingUsers = Object.keys(rooms[roomId].users);
                if (remainingUsers.length > 0) {
                    rooms[roomId].host = remainingUsers[0];
                    console.log(`[NEW HOST] User ${rooms[roomId].host} is the new host for room ${roomId}`);
                } else {
                    delete rooms[roomId];
                }
            } else if (Object.keys(rooms[roomId].users).length === 0) {
                delete rooms[roomId];
            }
        }
        console.log(`[DISCONNECT] User disconnected: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`============================================`);
    console.log(`  Cloud Prototype Server Running on Port ${PORT}`);
    console.log(`============================================`);
});
