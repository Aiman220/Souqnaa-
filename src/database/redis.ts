import Redis, { RedisOptions } from 'ioredis';
import crypto from 'crypto';
import { config } from '../config';

export interface RedisHealthStatus {
  ok: boolean;
  latencyMs: number;
  mode: 'upstash_redis' | 'local_redis' | 'memory_fallback';
  connected: boolean;
  error?: string;
}

export interface LockResult {
  acquired: boolean;
  token: string;
}

class RedisService {
  private client: Redis | null = null;
  private isConnected = false;
  private memoryCache = new Map<string, { value: string; expiry: number }>();
  private memorySets = new Map<string, Set<string>>();
  private memoryCounters = new Map<string, number>();

  constructor() {
    try {
      const redisOptions: RedisOptions = {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        retryStrategy: (times) => (times > 3 ? null : Math.min(times * 100, 1000)),
      };

      if (config.redis.url) {
        if (config.redis.tls) {
          redisOptions.tls = { rejectUnauthorized: false };
        }
        this.client = new Redis(config.redis.url, redisOptions);
      } else {
        redisOptions.host = config.redis.host;
        redisOptions.port = config.redis.port;
        redisOptions.password = config.redis.password;
        if (config.redis.tls) {
          redisOptions.tls = { rejectUnauthorized: false };
        }
        this.client = new Redis(redisOptions);
      }

      this.client.connect().then(() => {
        this.isConnected = true;
        const targetType = (config.redis.url || config.redis.host).includes('upstash.io')
          ? 'Upstash Redis (TLS)'
          : 'Redis';
        console.log(`[Redis] Connected successfully to ${targetType}.`);
      }).catch((err) => {
        this.isConnected = false;
        console.warn(`[Redis] Server not reachable (${err.message}). Using in-memory cache fallback.`);
      });

      this.client.on('error', () => {
        this.isConnected = false;
      });

      this.client.on('connect', () => {
        this.isConnected = true;
      });

      this.client.on('close', () => {
        this.isConnected = false;
      });
    } catch (e) {
      this.isConnected = false;
    }
  }

  // ── String / JSON ─────────────────────────────────────────────────────────

  async get(key: string): Promise<string | null> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.get(key);
      } catch (_) {}
    }
    const item = this.memoryCache.get(key);
    if (!item) return null;
    if (item.expiry > 0 && Date.now() > item.expiry) {
      this.memoryCache.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds = 0): Promise<void> {
    if (this.isConnected && this.client) {
      try {
        if (ttlSeconds > 0) {
          await this.client.setex(key, ttlSeconds, value);
        } else {
          await this.client.set(key, value);
        }
        return;
      } catch (_) {}
    }
    const expiry = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0;
    this.memoryCache.set(key, { value, expiry });
  }

  async del(key: string): Promise<void> {
    if (this.isConnected && this.client) {
      try {
        await this.client.del(key);
        return;
      } catch (_) {}
    }
    this.memoryCache.delete(key);
    this.memorySets.delete(key);
    this.memoryCounters.delete(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: any, ttlSeconds = 0): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  // ── Atomic Counters ───────────────────────────────────────────────────────

  /** Atomically increment a counter and return the new value. */
  async incr(key: string): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.incr(key);
      } catch (_) {}
    }
    const current = this.memoryCounters.get(key) ?? 0;
    const next = current + 1;
    this.memoryCounters.set(key, next);
    return next;
  }

  /** Atomically decrement a counter (floor at 0 in memory fallback) and return the new value. */
  async decr(key: string): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.decr(key);
      } catch (_) {}
    }
    const current = this.memoryCounters.get(key) ?? 0;
    const next = Math.max(0, current - 1);
    this.memoryCounters.set(key, next);
    return next;
  }

  /** Atomically increment by n and return the new value. */
  async incrBy(key: string, n: number): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.incrby(key, n);
      } catch (_) {}
    }
    const current = this.memoryCounters.get(key) ?? 0;
    const next = current + n;
    this.memoryCounters.set(key, next);
    return next;
  }

  /** Set a counter to a specific value. */
  async setCounter(key: string, value: number): Promise<void> {
    if (this.isConnected && this.client) {
      try {
        await this.client.set(key, String(value));
        return;
      } catch (_) {}
    }
    this.memoryCounters.set(key, value);
  }

  /** Get a counter value (returns 0 if not set). */
  async getCounter(key: string): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        const val = await this.client.get(key);
        return val ? parseInt(val, 10) : 0;
      } catch (_) {}
    }
    return this.memoryCounters.get(key) ?? 0;
  }

  // ── Sets (for deduplication / notification grouping) ─────────────────────

  /** Add members to a Redis set. Returns number of members actually added. */
  async sadd(key: string, ...members: string[]): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.sadd(key, ...members);
      } catch (_) {}
    }
    const set = this.memorySets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    this.memorySets.set(key, set);
    return added;
  }

  /** Check if a member exists in a set. */
  async sismember(key: string, member: string): Promise<boolean> {
    if (this.isConnected && this.client) {
      try {
        const result = await this.client.sismember(key, member);
        return result === 1;
      } catch (_) {}
    }
    return this.memorySets.get(key)?.has(member) ?? false;
  }

  /** Get all members of a set. */
  async smembers(key: string): Promise<string[]> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.smembers(key);
      } catch (_) {}
    }
    return Array.from(this.memorySets.get(key) ?? []);
  }

  /** Get the cardinality (size) of a set. */
  async scard(key: string): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.scard(key);
      } catch (_) {}
    }
    return this.memorySets.get(key)?.size ?? 0;
  }

  /** Remove members from a set. */
  async srem(key: string, ...members: string[]): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.srem(key, ...members);
      } catch (_) {}
    }
    const set = this.memorySets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  // ── TTL ───────────────────────────────────────────────────────────────────

  /** Set a TTL (in seconds) on an existing key. */
  async expire(key: string, seconds: number): Promise<void> {
    if (this.isConnected && this.client) {
      try {
        await this.client.expire(key, seconds);
        return;
      } catch (_) {}
    }
    const item = this.memoryCache.get(key);
    if (item) {
      item.expiry = Date.now() + seconds * 1000;
    }
  }

  /** Get remaining TTL (in seconds) on a key. Returns -2 if not found, -1 if no expiry. */
  async ttl(key: string): Promise<number> {
    if (this.isConnected && this.client) {
      try {
        return await this.client.ttl(key);
      } catch (_) {}
    }
    const item = this.memoryCache.get(key);
    if (!item) return -2;
    if (item.expiry <= 0) return -1;
    const remainingMs = item.expiry - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : -2;
  }

  // ── Distributed Locks (SET NX EX + Atomic Lua Release) ───────────────────

  /**
   * Acquire a distributed lock with TTL using Redis SET NX EX (or in-memory mutex fallback).
   */
  async acquireLock(lockKey: string, ttlSeconds = 10, customToken?: string): Promise<LockResult> {
    const token = customToken || crypto.randomUUID();
    const key = `lock:${lockKey}`;

    if (this.isConnected && this.client) {
      try {
        const result = await this.client.set(key, token, 'EX', ttlSeconds, 'NX');
        if (result === 'OK') {
          return { acquired: true, token };
        }
        return { acquired: false, token: '' };
      } catch (err) {
        console.warn(`[Redis] acquireLock network failure, fallback to memory: ${err}`);
      }
    }

    // In-memory fallback
    const now = Date.now();
    const existing = this.memoryCache.get(key);
    if (existing && (existing.expiry === 0 || existing.expiry > now)) {
      return { acquired: false, token: '' };
    }
    this.memoryCache.set(key, { value: token, expiry: now + ttlSeconds * 1000 });
    return { acquired: true, token };
  }

  /**
   * Release a distributed lock safely using an atomic Lua script (releases only if token matches).
   */
  async releaseLock(lockKey: string, token: string): Promise<boolean> {
    const key = `lock:${lockKey}`;

    if (this.isConnected && this.client) {
      try {
        const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        const result = await this.client.eval(luaScript, 1, key, token);
        return result === 1;
      } catch (err) {
        console.warn(`[Redis] releaseLock network failure, fallback to memory: ${err}`);
      }
    }

    // In-memory fallback
    const existing = this.memoryCache.get(key);
    if (existing && existing.value === token) {
      this.memoryCache.delete(key);
      return true;
    }
    return false;
  }

  // ── Idempotency Keys ─────────────────────────────────────────────────────

  /**
   * Atomically acquire an idempotency record for financial / critical mutations.
   * Prevents concurrent execution of duplicate client submissions.
   */
  async acquireIdempotency(
    idempotencyKey: string,
    ttlSeconds = 86400
  ): Promise<{ isFirstAttempt: boolean; status?: 'PENDING' | 'COMPLETED'; result?: any }> {
    const key = `idempotency:${idempotencyKey}`;
    const initialPayload = JSON.stringify({ status: 'PENDING', createdAt: Date.now() });

    if (this.isConnected && this.client) {
      try {
        const res = await this.client.set(key, initialPayload, 'EX', ttlSeconds, 'NX');
        if (res === 'OK') {
          return { isFirstAttempt: true, status: 'PENDING' };
        }
        const existingRaw = await this.client.get(key);
        if (existingRaw) {
          try {
            const parsed = JSON.parse(existingRaw);
            return { isFirstAttempt: false, status: parsed.status, result: parsed.result };
          } catch (_) {
            return { isFirstAttempt: false, status: 'COMPLETED' };
          }
        }
      } catch (_) {}
    }

    // In-memory fallback
    const existing = this.memoryCache.get(key);
    const now = Date.now();
    if (existing && (existing.expiry === 0 || existing.expiry > now)) {
      try {
        const parsed = JSON.parse(existing.value);
        return { isFirstAttempt: false, status: parsed.status, result: parsed.result };
      } catch {
        return { isFirstAttempt: false, status: 'COMPLETED' };
      }
    }

    this.memoryCache.set(key, { value: initialPayload, expiry: now + ttlSeconds * 1000 });
    return { isFirstAttempt: true, status: 'PENDING' };
  }

  /**
   * Complete an idempotency record with cached execution response.
   */
  async completeIdempotency(
    idempotencyKey: string,
    result: any,
    ttlSeconds = 86400
  ): Promise<void> {
    const key = `idempotency:${idempotencyKey}`;
    const payload = JSON.stringify({ status: 'COMPLETED', completedAt: Date.now(), result });
    await this.set(key, payload, ttlSeconds);
  }

  // ── Observability & Health Check ──────────────────────────────────────────

  /**
   * Ping Redis to test connectivity and measure round-trip latency.
   */
  async ping(): Promise<RedisHealthStatus> {
    const start = Date.now();
    const isUpstash = Boolean(
      (config.redis.url || config.redis.host || '').includes('upstash.io')
    );
    const mode = this.isConnected
      ? (isUpstash ? 'upstash_redis' : 'local_redis')
      : 'memory_fallback';

    if (this.isConnected && this.client) {
      try {
        const reply = await this.client.ping();
        const latencyMs = Date.now() - start;
        return {
          ok: reply === 'PONG',
          latencyMs,
          mode,
          connected: true,
        };
      } catch (err: any) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          mode: 'memory_fallback',
          connected: false,
          error: err.message,
        };
      }
    }

    return {
      ok: true,
      latencyMs: 0,
      mode: 'memory_fallback',
      connected: false,
      error: 'Redis offline; memory fallback active',
    };
  }

  /**
   * Returns current connection state.
   */
  isHealthy(): boolean {
    return this.isConnected;
  }

  /**
   * Returns underlying ioredis client or null.
   */
  getClient(): Redis | null {
    return this.client;
  }

  /**
   * Disconnect Redis client (e.g. during graceful shutdown).
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch (_) {
        this.client.disconnect();
      }
      this.isConnected = false;
    }
  }
}

export const redis = new RedisService();
export const redisService = redis;
