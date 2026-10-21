import rateLimit from 'express-rate-limit';
import { ResponseUtil } from '../utils/response.util';
import { config } from '../config';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.env === 'development' ? 100000 : 5000, // Generous limit
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting in development or for local loopback requests
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Too many requests from this IP. Please try again after a moment.',
      429
    );
  },
});

export const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: config.env === 'development' ? 10000 : 10, // 10 attempts per 10 min (brute-force hardening)
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Too many authentication attempts. Please try again after 10 minutes.',
      429
    );
  },
});

/** File upload: 10 uploads per 10 minutes per authenticated user. */
export const uploadFileLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: config.env === 'development' ? 10000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Upload limit reached. Maximum 10 file uploads per 10 minutes.',
      429
    );
  },
});

/** Upload-by-URL (remote fetch): 5 per 10 minutes per user — tighter due to SSRF risk surface. */
export const uploadByUrlLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: config.env === 'development' ? 10000 : 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Remote URL import limit reached. Maximum 5 URL imports per 10 minutes.',
      429
    );
  },
});

export const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: config.env === 'development' ? 2000 : 120, // General chat API limit
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Too many chat requests. Please slow down.',
      429
    );
  },
});

export const chatMessageLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: config.env === 'development' ? 2000 : config.rateLimits.chatMessagesPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      `Message rate limit exceeded. Maximum ${config.rateLimits.chatMessagesPerMinute} messages per minute.`,
      429
    );
  },
});

export const conversationCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.env === 'development' ? 1000 : config.rateLimits.conversationsPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      `Conversation creation limit reached. Maximum ${config.rateLimits.conversationsPerHour} new conversations per hour.`,
      429
    );
  },
});

export const chatUploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.env === 'development' ? 1000 : config.rateLimits.uploadsPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      `Upload limit reached. Maximum ${config.rateLimits.uploadsPerHour} file uploads per hour.`,
      429
    );
  },
});

export const chatReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: config.env === 'development' ? 1000 : config.rateLimits.reportsPerHour,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      `Report limit reached. Maximum ${config.rateLimits.reportsPerHour} reports per hour.`,
      429
    );
  },
});

/** Anti-abuse: 30 follow/unfollow actions per minute per authenticated user. */
export const followLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.env === 'development' ? 10000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Too many follow/unfollow actions. Maximum 30 per minute. Please slow down.',
      429
    );
  },
});

/** Public storefront pages: 200 requests per minute per IP. */
export const storefrontLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.env === 'development' ? 10000 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Too many storefront requests. Please try again shortly.',
      429
    );
  },
});

/** Search & Autocomplete: 90 requests per minute per IP to prevent keystroke DDOS (§22, §25). */
export const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.env === 'development' ? 10000 : 90,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Search rate limit exceeded. Please wait a moment before searching again.',
      429
    );
  },
});

/** Checkout & Order Creation: 30 requests per minute per authenticated user/IP (§18, §25). */
export const checkoutLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.env === 'development' ? 10000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Order creation limit reached. Please wait before placing another order.',
      429
    );
  },
});

/** Flash Sale & High-Concurrency Reservations: 40 requests per minute (§17, §25, §44). */
export const flashSaleLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.env === 'development' ? 10000 : 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Flash sale reservation limit exceeded. Please wait a moment.',
      429
    );
  },
});

/** Financial Transactions & Wallet Operations: 20 requests per minute (§19, §25, §26). */
export const financialLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.env === 'development' ? 10000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?.userId || req.ip || 'anonymous',
  skip: (req) => {
    if (config.env === 'development') return true;
    const ip = req.ip || req.socket.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
  handler: (req, res) => {
    ResponseUtil.error(
      res,
      'Financial mutation rate limit reached. Please try again in a few moments.',
      429
    );
  },
});

