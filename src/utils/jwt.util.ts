import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';
import { UserRoleType } from '@prisma/client';

export interface TokenPayload {
  userId: string;
  email: string;
  role: UserRoleType;
  iat?: number;
  exp?: number;
  sid?: string;
}

export class JwtUtil {
  static generateTokens(payload: TokenPayload): { accessToken: string; refreshToken: string; expiresIn: number; sessionId: string } {
    const sessionId = payload.sid || crypto.randomUUID();
    const sessionPayload = { ...payload, sid: sessionId };
    const accessToken = jwt.sign({ ...sessionPayload, jti: crypto.randomUUID() }, config.jwt.secret as Secret, {
      expiresIn: config.jwt.expiresIn,
    } as SignOptions);

    const refreshToken = jwt.sign({ ...sessionPayload, jti: crypto.randomUUID() }, config.jwt.refreshSecret as Secret, {
      expiresIn: config.jwt.refreshExpiresIn,
    } as SignOptions);

    // 30 days in seconds = 2592000
    const expiresIn = 2592000;

    return { accessToken, refreshToken, expiresIn, sessionId };
  }

  static verifyAccessToken(token: string): TokenPayload {
    return jwt.verify(token, config.jwt.secret as Secret) as TokenPayload;
  }

  static verifyRefreshToken(token: string): TokenPayload {
    return jwt.verify(token, config.jwt.refreshSecret as Secret) as TokenPayload;
  }
}
