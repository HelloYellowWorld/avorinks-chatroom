const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Configure WebSocket server on /ws path to avoid conflicts
const wss = new WebSocket.Server({ server: server, path: '/ws' });

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Middleware for parsing JSON and handling file uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Store connected clients and chat history
const clients = new Set();
const chatHistory = [];
const MAX_HISTORY = 100;

// Owner authentication
const OWNER_CODE = process.env.OWNER_CODE || 'avomaster123'; // Can be changed via environment variable
const owners = new Set(); // Track authenticated owners

// IP tracking for security
const ipLogFile = path.join(__dirname, 'ip_logs.txt');
const connectionLog = new Map(); // Track active connections with metadata

// Function to log IP addresses
function logUserConnection(ip, username, action) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} | ${action} | IP: ${ip} | Username: ${username}\n`;
    
    fs.appendFile(ipLogFile, logEntry, (err) => {
        if (err) {
            console.error('Error writing to IP log:', err);
        }
    });
}

// Function to get client IP address
function getClientIp(req) {
    return req.headers['x-forwarded-for'] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null);
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    // Get client IP address
    const clientIp = getClientIp(req);
    
    // Store connection metadata
    connectionLog.set(ws, {
        ip: clientIp,
        connectTime: new Date().toISOString(),
        username: null
    });
    
    // Log initial connection
    logUserConnection(clientIp, 'Anonymous', 'CONNECTED');
    
    console.log(`New client connected from ${clientIp}. Total clients:`, clients.size + 1);
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
            
            if (message.type === 'owner_auth' && message.code) {
                // Handle owner authentication
                if (message.code === OWNER_CODE) {
                    owners.add(ws);
                    ws.send(JSON.stringify({
                        type: 'owner_status',
                        isOwner: true,
                        message: 'Owner authentication successful! You now have admin privileges.',
                        timestamp: new Date().toISOString()
                    }));
                    console.log('Owner authenticated successfully');
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid owner code',
                        timestamp: new Date().toISOString()
                    }));
                }
                
            } else if (message.type === 'chat' && message.content && message.username) {
                // Check if user is owner for special formatting
                const isOwner = owners.has(ws);
                
                // Update connection log with username
                if (connectionLog.has(ws)) {
                    const connData = connectionLog.get(ws);
                    if (!connData.username) {
                        connData.username = message.username;
                        logUserConnection(connData.ip, message.username, 'USERNAME_SET');
                    }
                }
                
                // Create message object
                const chatMessage = {
                    type: 'chat',
                    username: message.username.substring(0, 20), // Limit username length
                    content: message.content.substring(0, 500), // Limit message length
                    timestamp: new Date().toISOString(),
                    id: Date.now() + Math.random(),
                    isOwner: isOwner
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
                
                console.log(`Message from ${chatMessage.username}${isOwner ? ' [OWNER]' : ''}: ${chatMessage.content}`);
                
            } else if (message.type === 'owner_command' && message.command && owners.has(ws)) {
                // Handle owner-only commands
                if (message.command === 'ips') {
                    // Send IP information to owner
                    const activeConnections = Array.from(connectionLog.values()).map(conn => ({
                        ip: conn.ip,
                        username: conn.username || 'Anonymous',
                        connectTime: new Date(conn.connectTime).toLocaleString()
                    }));
                    
                    ws.send(JSON.stringify({
                        type: 'owner_data',
                        command: 'ips',
                        data: activeConnections,
                        timestamp: new Date().toISOString()
                    }));
                }
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
        // Log disconnection
        if (connectionLog.has(ws)) {
            const connData = connectionLog.get(ws);
            logUserConnection(connData.ip, connData.username || 'Anonymous', 'DISCONNECTED');
            connectionLog.delete(ws);
        }
        
        clients.delete(ws);
        owners.delete(ws); // Remove from owners if they were authenticated
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

// Owner-only endpoint to view IP logs
app.get('/admin/ips', (req, res) => {
    const authCode = req.query.code;
    
    if (authCode !== OWNER_CODE) {
        return res.status(403).json({ error: 'Access denied' });
    }
    
    // Read IP log file
    fs.readFile(ipLogFile, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ error: 'Unable to read IP logs' });
        }
        
        // Parse logs and format them
        const logs = data.split('\n').filter(line => line.trim());
        const formattedLogs = logs.map(line => {
            const parts = line.split(' | ');
            if (parts.length >= 4) {
                return {
                    timestamp: parts[0],
                    action: parts[1],
                    ip: parts[2],
                    username: parts[3]
                };
            }
            return null;
        }).filter(log => log !== null);
        
        // Get current active connections
        const activeConnections = Array.from(connectionLog.values()).map(conn => ({
            ip: conn.ip,
            username: conn.username || 'Anonymous',
            connectTime: conn.connectTime
        }));
        
        res.json({
            success: true,
            activeConnections,
            totalLogs: formattedLogs.length,
            recentLogs: formattedLogs.slice(-50), // Last 50 entries
            timestamp: new Date().toISOString()
        });
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
