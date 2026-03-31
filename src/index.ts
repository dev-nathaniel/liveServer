import dotenv from 'dotenv';
dotenv.config(); // Must run before importing config.ts so env vars are available

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { createWorkers, createWebRtcTransport } from './mediasoupManager';
import { getOrCreateRoom, removePeerFromRoom, rooms } from './roomManager';
import { verifyToken, generateToken } from './auth';
import { startRecording, stopRecording } from './recorder';
import { Peer, User, Role } from './types';
import { config } from './config';

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

// Endpoint to generate a token
app.post('/api/token', (req, res) => {
  const { userId, role, channelName, expiresIn, username, profilePicture } = req.body;
  if (!userId || !role || !channelName) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  const token = generateToken(
    { userId, role: role as Role, channelName, username, profilePicture },
    expiresIn || '2h'
  );
  res.json({ token });
});

// Middleware for Socket.io — accept userId only (auth happens at joinRoom)
io.use((socket, next) => {
  const userId = socket.handshake.auth.userId;
  if (!userId) return next(new Error('Missing userId'));
  (socket as any).userId = userId as string;
  (socket as any).currentRoom = null as string | null;
  (socket as any).user = null as (User & { channelName: string }) | null;
  next();
});

io.on('connection', (socket: Socket) => {
  const socketUserId = (socket as any).userId as string;
  console.log(`Socket connected: userId=${socketUserId}`);

  socket.on('joinRoom', async ({ channelName, token }: { channelName: string; token: string }, callback: Function) => {
    try {
      // Verify the room-specific token
      const payload = verifyToken(token);
      if (!payload || payload.channelName !== channelName) {
        return callback({ error: 'Invalid or mismatched token' });
      }

      // Leave previous room if already in one
      const prevRoom = (socket as any).currentRoom as string | null;
      if (prevRoom) {
        await stopRecording(socketUserId).catch(() => {});
        removePeerFromRoom(prevRoom, socket.id, io);
        socket.leave(prevRoom);
      }

      // Attach authenticated user data for this room
      const user: User = { 
        userId: payload.userId, 
        role: payload.role,
        username: payload.username,
        profilePicture: payload.profilePicture
      };
      (socket as any).user = { ...user, channelName };
      (socket as any).currentRoom = channelName;

      const room = await getOrCreateRoom(channelName);

      room.peers.set(socket.id, {
        socketId: socket.id,
        user,
        transports: new Map(),
        producers: new Map(),
        consumers: new Map(),
      });

      socket.join(channelName);

      // Notify existing users with full metadata
      socket.to(channelName).emit('peerJoined', { 
        peerId: socket.id, 
        userId: user.userId, 
        role: user.role,
        username: user.username,
        profilePicture: user.profilePicture
      });

      // Send router RTP capabilities and existing peers with metadata
      callback({
        routerRtpCapabilities: room.router.rtpCapabilities,
        peers: Array.from(room.peers.values()).map(p => ({
          peerId: p.socketId,
          userId: p.user.userId,
          role: p.user.role,
          username: p.user.username,
          profilePicture: p.user.profilePicture,
          isMuted: Array.from(p.producers.values()).some(prod => prod.paused),
          isRecording: false
        }))
      });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('leaveRoom', async (callback: Function) => {
    const roomId = (socket as any).currentRoom as string | null;
    if (roomId) {
      await stopRecording(socketUserId).catch(() => {});
      removePeerFromRoom(roomId, socket.id, io);
      socket.leave(roomId);
      (socket as any).currentRoom = null;
      (socket as any).user = null;
    }
    callback?.({ success: true });
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
      const user = (socket as any).user as (User & { channelName: string }) | null;
      if (!user || user.role !== 'broadcaster') {
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

  socket.on('toggleMic', async ({ roomId, producerId, isMuted }, callback: Function) => {
    try {
      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (!producer) throw new Error('Producer not found');

      if (isMuted) {
        await producer.pause();
      } else {
        await producer.resume();
      }

      socket.to(roomId).emit('peerMicToggled', { peerId: socket.id, isMuted });
      callback({ success: true });
    } catch (error: any) {
      console.error(error);
      callback({ error: error.message });
    }
  });

  socket.on('startRecording', async (data: { roomId: string, producerId: string, bucketName: string, eventId: string }, callback: Function) => {
    try {
      const { roomId, producerId, bucketName, eventId } = data;
      const room = rooms.get(roomId);
      const peer = room?.peers.get(socket.id);
      const producer = peer?.producers.get(producerId);
      if (!room || !producer) throw new Error('Producer not found');

      await startRecording(room.router, producer, socketUserId, bucketName, eventId);
      socket.to(roomId).emit('peerRecordingStarted', { peerId: socket.id });
      callback({ success: true });
    } catch (e: any) {
      console.error(e);
      callback({ error: e.message });
    }
  });

  socket.on('stopRecording', async (callback: Function) => {
    try {
      const currentRoom = (socket as any).currentRoom as string | null;
      await stopRecording(socketUserId);
      if (currentRoom) {
        socket.to(currentRoom).emit('peerRecordingStopped', { peerId: socket.id });
      }
      callback({ success: true });
    } catch (e: any) {
      console.error(e);
      callback({ error: e.message });
    }
  });

  socket.on('disconnect', () => {
    const currentRoom = (socket as any).currentRoom as string | null;
    stopRecording(socketUserId).catch(() => {});
    console.log(`User ${socketUserId} disconnected`);
    if (currentRoom) {
      removePeerFromRoom(currentRoom, socket.id, io);
    }
  });
});

async function start() {
  await createWorkers();
  server.listen(config.listenPort, config.listenIp, () => {
    console.log(`Server listening on http://${config.listenIp}:${config.listenPort}`);
  });
}

start();
