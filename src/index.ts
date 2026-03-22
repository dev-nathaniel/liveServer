import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { createWorkers, createWebRtcTransport } from './mediasoupManager';
import { getOrCreateRoom, removePeerFromRoom, rooms } from './roomManager';
import { verifyToken, generateToken } from './auth';
import { Peer, User } from './types';
import { config } from './config';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', activeRooms: rooms.size });
});

// Basic endpoint to generate a token for testing
app.post('/api/token', (req, res) => {
  const { userId, role, roomId } = req.body;
  if (!userId || !role || !roomId) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const token = generateToken({ userId, role, roomId });
  res.json({ token });
});

// Middleware for Socket.io authentication
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  
  const payload = verifyToken(token);
  if (!payload) return next(new Error('Invalid token'));
  
  // Attach user to socket
  (socket as any).user = payload;
  next();
});

io.on('connection', (socket: Socket) => {
  const user = (socket as any).user as User & { roomId: string };
  console.log(`User ${user.userId} connected to room ${user.roomId}`);

  socket.on('joinRoom', async (roomId: string, callback: Function) => {
    if (user.roomId !== roomId) {
      return callback({ error: 'Token not valid for this room' });
    }

    const room = await getOrCreateRoom(roomId);
    
    room.peers.set(socket.id, {
      socketId: socket.id,
      user,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
    });

    socket.join(roomId);
    
    // Send router RTP capabilities
    callback({ routerRtpCapabilities: room.router.rtpCapabilities });
  });

  socket.on('getProducers', ({ roomId }, callback: Function) => {
    const room = rooms.get(roomId);
    if (!room) return callback([]);
    
    const producerIds: { id: string, userId: string }[] = [];
    for (const [peerSocketId, peer] of room.peers.entries()) {
      if (peerSocketId === socket.id) continue;
      for (const producerId of peer.producers.keys()) {
        producerIds.push({ id: producerId, userId: peer.user.userId });
      }
    }
    callback(producerIds);
  });

  socket.on('createWebRtcTransport', async ({ roomId }, callback: Function) => {
    try {
      const room = rooms.get(roomId);
      if (!room) throw new Error('Room not found');

      const transport = await createWebRtcTransport(room.router);
      const peer = room.peers.get(socket.id);
      if (peer) {
        peer.transports.set(transport.id, transport);
      }

      callback({
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }
      });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('connectTransport', async ({ roomId, transportId, dtlsParameters }, callback: Function) => {
    try {
      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      if (!peer) throw new Error('Peer not found');

      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      await transport.connect({ dtlsParameters });
      callback({ connected: true });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('produce', async ({ roomId, transportId, kind, rtpParameters }, callback: Function) => {
    try {
      if (user.role !== 'speaker') {
        throw new Error('Not authorized to produce');
      }

      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      if (!peer) throw new Error('Peer not found');

      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      const producer = await transport.produce({ kind, rtpParameters });
      peer.producers.set(producer.id, producer);

      // Notify others in room
      socket.to(roomId).emit('newProducer', {
        producerId: producer.id,
        socketId: socket.id,
        userId: user.userId,
      });

      callback({ id: producer.id });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('consume', async ({ roomId, producerId, transportId, rtpCapabilities }, callback: Function) => {
    try {
      const room = rooms.get(roomId);
      if (!room) throw new Error('Room not found');
      
      const peer = room.peers.get(socket.id);
      if (!peer) throw new Error('Peer not found');

      const transport = peer.transports.get(transportId);
      if (!transport) throw new Error('Transport not found');

      if (!room.router.canConsume({ producerId, rtpCapabilities })) {
        throw new Error('Cannot consume');
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: true, // start paused
      });

      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer.id);
      });

      consumer.on('producerclose', () => {
        peer.consumers.delete(consumer.id);
        socket.emit('consumerClosed', { consumerId: consumer.id });
      });

      callback({
        params: {
          id: consumer.id,
          producerId: producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }
      });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('resumeConsumer', async ({ roomId, consumerId }, callback: Function) => {
    try {
      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) throw new Error('Consumer not found');

      await consumer.resume();
      callback({ resumed: true });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User ${user.userId} disconnected`);
    removePeerFromRoom(user.roomId, socket.id, io);
  });
});

async function start() {
  await createWorkers();
  server.listen(config.listenPort, config.listenIp, () => {
    console.log(`Server listening on http://${config.listenIp}:${config.listenPort}`);
  });
}

start();
