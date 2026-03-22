import { Router } from 'mediasoup/node/lib/types';
import { Room, Peer } from './types';
import { createRouter } from './mediasoupManager';
import { Server } from 'socket.io';

export const rooms = new Map<string, Room & { router: Router }>();

export async function getOrCreateRoom(roomId: string): Promise<Room & { router: Router }> {
  let room = rooms.get(roomId);
  if (!room) {
    const router = await createRouter();
    room = {
      id: roomId,
      routerId: router.id,
      router,
      peers: new Map<string, Peer>(),
    };
    rooms.set(roomId, room);
    console.log(`Created room ${roomId}`);
  }
  return room;
}

export function removePeerFromRoom(roomId: string, socketId: string, io: Server) {
  const room = rooms.get(roomId);
  if (!room) return;

  const peer = room.peers.get(socketId);
  if (peer) {
    for (const transport of peer.transports.values()) {
      transport.close();
    }
    room.peers.delete(socketId);

    // Notify other peers
    io.to(roomId).emit('peerClosed', { peerId: socketId });

    if (room.peers.size === 0) {
      console.log(`Room ${roomId} is empty, closing...`);
      room.router.close();
      rooms.delete(roomId);
    }
  }
}
