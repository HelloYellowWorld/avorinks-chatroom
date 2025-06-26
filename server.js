const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configure WebSocket server on /ws path to avoid conflicts
const wss = new WebSocket.Server({ server: server, path: '/ws' });

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store connected clients and chat history
const clients = new Set();
const chatHistory = [];
const MAX_HISTORY = 100;

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    console.log('New client connected from:', req.socket.remoteAddress);
    clients.add(ws);
    
    // Send chat history to new client
    if (chatHistory.length > 0) {
        ws.send(JSON.stringify({
            type: 'history',
            messages: chatHistory
        }));
    }
    
    // Send welcome message
    ws.send(JSON.stringify({
        type: 'system',
        message: 'Welcome to the chatroom! You are now connected.',
        timestamp: new Date().toISOString()
    }));
    
    // Handle incoming messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'chat' && message.content && message.username) {
                // Create message object
                const chatMessage = {
                    type: 'chat',
                    username: message.username.substring(0, 20), // Limit username length
                    content: message.content.substring(0, 500), // Limit message length
                    timestamp: new Date().toISOString(),
                    id: Date.now() + Math.random()
                };
                
                // Add to history
                chatHistory.push(chatMessage);
                if (chatHistory.length > MAX_HISTORY) {
                    chatHistory.shift();
                }
                
                // Broadcast to all connected clients
                const messageStr = JSON.stringify(chatMessage);
                clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(messageStr);
                    }
                });
                
                console.log(`Message from ${chatMessage.username}: ${chatMessage.content}`);
            }
        } catch (error) {
            console.error('Error processing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format',
                timestamp: new Date().toISOString()
            }));
        }
    });
    
    // Handle client disconnect
    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client disconnected. Active clients:', clients.size);
    });
    
    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeClients: clients.size,
        chatHistory: chatHistory.length,
        timestamp: new Date().toISOString()
    });
});

// Default route - serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server - Use PORT environment variable (Render uses 10000 by default)
const PORT = process.env.PORT || 10000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Chatroom server running on http://${HOST}:${PORT}`);
    console.log(`WebSocket server available at ws://${HOST}:${PORT}/ws`);
    console.log('Ready for connections!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
