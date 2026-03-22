import jwt from 'jsonwebtoken';
import { Role } from './types';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-production';

export interface TokenPayload {
  userId: string;
  role: Role;
  roomId: string;
}

export function generateToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '2h' });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}
