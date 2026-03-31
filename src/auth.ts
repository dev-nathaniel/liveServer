import jwt, { SignOptions } from 'jsonwebtoken';
import { Role } from './types';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-production';

export interface TokenPayload {
  userId: string;
  username: string;
  profilePicture: string | null;
  role: Role;
  channelName: string;
}

export function generateToken(payload: TokenPayload, expiresIn: SignOptions['expiresIn'] = '2h'): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
  } catch (error) {
    return null;
  }
}
