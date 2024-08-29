const express = require('express');
const session = require('express-session');
const { createClient } = require('redis');
const RedisStore = require('connect-redis').default;
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Initialize Redis client
let redisClient = createClient({
  url: process.env.REDIS_URL
});

redisClient.connect().catch(console.error);

// Initialize Redis store
let redisStore = new RedisStore({
  client: redisClient,
  prefix: "rizztalk:",
});

const sessionMiddleware = session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'your_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 // 1 day
  }
});

app.use(sessionMiddleware);
app.use(express.json());

// Wrap express-session middleware for use with Socket.IO
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

io.use(wrap(sessionMiddleware));

// Queue management functions
async function addToQueue(userId) {
  await redisClient.rPush('user_queue', userId);
  console.log(`User ${userId} added to queue`);
}

async function removeFromQueue(userId) {
  await redisClient.lRem('user_queue', 0, userId);
  console.log(`User ${userId} removed from queue`);
}

async function matchUsers() {
  const user1 = await redisClient.lPop('user_queue');
  const user2 = await redisClient.lPop('user_queue');
  
  if (user1 && user2) {
    console.log(`Matched users: ${user1} and ${user2}`);
    return [user1, user2];
  }
  
  if (user1) {
    await redisClient.lPush('user_queue', user1);
    console.log(`User ${user1} returned to queue`);
  }
  return null;
}

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join queue', async () => {
    await addToQueue(socket.id);
    socket.emit('queue status', { status: 'joined', message: 'You have joined the queue.' });
  });

  socket.on('leave queue', async () => {
    await removeFromQueue(socket.id);
    socket.emit('queue status', { status: 'left', message: 'You have left the queue.' });
  });

  socket.on('skip user', async () => {
    if (socket.partner) {
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) {
        partnerSocket.emit('partner skipped');
        await addToQueue(partnerSocket.id);
        partnerSocket.partner = null;
      }
      socket.partner = null;
    }
    await addToQueue(socket.id);
    socket.emit('queue status', { status: 'joined', message: 'You have rejoined the queue.' });
  });

  // WebRTC signaling
  socket.on('offer', (offer, targetUserId) => {
    console.log(`Offer received from ${socket.id} to ${targetUserId}`);
    socket.to(targetUserId).emit('offer', offer, socket.id);
  });

  socket.on('answer', (answer, targetUserId) => {
    console.log(`Answer received from ${socket.id} to ${targetUserId}`);
    socket.to(targetUserId).emit('answer', answer, socket.id);
  });

  socket.on('ice-candidate', (candidate, targetUserId) => {
    console.log(`ICE candidate received from ${socket.id} to ${targetUserId}`);
    socket.to(targetUserId).emit('ice-candidate', candidate, socket.id);
  });

  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    await removeFromQueue(socket.id);
    if (socket.partner) {
      const partnerSocket = io.sockets.sockets.get(socket.partner);
      if (partnerSocket) {
        partnerSocket.emit('partner skipped');
        await addToQueue(partnerSocket.id);
        partnerSocket.partner = null;
      }
    }
  });
});

// Match-making interval
setInterval(async () => {
  const match = await matchUsers();
  if (match) {
    const [user1, user2] = match;
    console.log(`Emitting 'match found' to users ${user1} and ${user2}`);
    io.to(user1).emit('match found', { partner: user2 });
    io.to(user2).emit('match found', { partner: user1 });
    const socket1 = io.sockets.sockets.get(user1);
    const socket2 = io.sockets.sockets.get(user2);
    if (socket1) socket1.partner = user2;
    if (socket2) socket2.partner = user1;
  }
}, 5000); // Check for matches every 5 seconds

// Routes
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
