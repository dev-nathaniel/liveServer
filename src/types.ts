import { Transport, Producer, Consumer } from 'mediasoup/node/lib/types';

export type Role = 'broadcaster' | 'audience';

export interface User {
  userId: string;
  username?: string;
  profilePicture?: string | null;
  role: Role;
  channelName: string;
  eventId?: string;
}

export interface Peer {
  socketId: string;
  user: User;
  transports: Map<string, Transport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

export interface Room {
  id: string;
  routerId: string; // The ID of the Mediasoup router associated with this room
  peers: Map<string, Peer>; // key is socketId
}
