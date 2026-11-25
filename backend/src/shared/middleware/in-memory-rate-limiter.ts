export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

type WindowEntry = { count: number; resetAt: number };

/**
 * Process-local abuse guard. Production deployments with multiple replicas must
 * also enforce the same policy at a shared gateway or distributed limiter.
 */
export class InMemoryRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Rate limit must be a positive integer.');
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error('Rate limit window must be a positive integer.');
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('Rate limit key capacity must be a positive integer.');
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) return { allowed: true, retryAfterSeconds: 0, remaining: this.limit };
    const remaining = Math.max(0, this.limit - current.count);
    return {
      allowed: current.count < this.limit,
      retryAfterSeconds: current.count < this.limit ? 0 : Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      remaining,
    };
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    let current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.prune(now);
      if (this.windows.size >= this.maxKeys) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(this.windowMs / 1000)), remaining: 0 };
      }
      current = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, current);
    }
    if (current.count >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)), remaining: 0 };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, this.limit - current.count) };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) this.windows.delete(key);
    }
  }
}
