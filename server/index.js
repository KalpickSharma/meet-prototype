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
        if (!rooms[roomId]) rooms[roomId] = {};

        const currentUsers = Object.keys(rooms[roomId]).length;
        if (currentUsers >= MAX_USERS_PER_ROOM) {
            socket.emit('room-full');
            return;
        }

        const existingUsers = Object.keys(rooms[roomId]);
        rooms[roomId][socket.id] = { id: socket.id };

        socket.join(roomId);
        socket.roomId = roomId;

        console.log(`[JOINED] User ${socket.id} joined room ${roomId}`);

        socket.emit('existing-users', existingUsers);
        socket.to(roomId).emit('user-joined', socket.id);
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
            delete rooms[roomId][socket.id];
            socket.to(roomId).emit('user-left', socket.id);
            if (Object.keys(rooms[roomId]).length === 0) delete rooms[roomId];
        }
        console.log(`[DISCONNECT] User disconnected: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`============================================`);
    console.log(`  Cloud Prototype Server Running on Port ${PORT}`);
    console.log(`============================================`);
});
