import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";

export interface AuthRateLimitOptions {
  /** Sliding window duration in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed within the sliding window. */
  maxRequests: number;
  /** Logical bucket namespace (e.g. "sign-in", "invite-accept"). */
  bucketName: string;
  /** Optional extractor for a secondary key (e.g. email or token). */
  keyExtractor?: (req: Request) => string | null | undefined;
}

const buckets = new Map<string, number[]>();
const MAX_TRACKED_BUCKETS = 10_000;

export function resetAuthRateLimitBuckets(): void {
  buckets.clear();
}

function extractClientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function hashKeyMaterial(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function defaultSecondaryKeyExtractor(req: Request): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body.email === "string" && body.email.trim()) {
    return `email:${body.email.trim().toLowerCase()}`;
  }
  const paramToken = typeof req.params?.token === "string" ? req.params.token.trim() : "";
  if (paramToken) {
    return `token:${hashKeyMaterial(paramToken)}`;
  }
  if (body && typeof body.token === "string" && body.token.trim()) {
    return `token:${hashKeyMaterial(body.token.trim())}`;
  }
  return null;
}

function pruneStaleBuckets(now: number, maxWindowMs: number): void {
  if (buckets.size <= MAX_TRACKED_BUCKETS) return;
  const cutoff = now - maxWindowMs;
  for (const [key, timestamps] of buckets.entries()) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1]! <= cutoff) {
      buckets.delete(key);
    }
  }
}

export function createAuthRateLimiter(options: AuthRateLimitOptions): RequestHandler {
  const { windowMs, maxRequests, bucketName, keyExtractor = defaultSecondaryKeyExtractor } = options;

  return (req, res, next) => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const ip = extractClientIp(req);
    const secondary = keyExtractor(req)?.trim().toLowerCase() || "_";
    const key = `${bucketName}:${ip}:${secondary}`;

    const existing = buckets.get(key) ?? [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= maxRequests) {
      const oldestInWindow = active[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      buckets.set(key, active);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Too many requests. Please try again later.",
        retryAfterSeconds,
      });
      return;
    }

    active.push(now);
    buckets.set(key, active);
    pruneStaleBuckets(now, windowMs);
    next();
  };
}
