// server/src/services/circuit-breaker.ts
const OPEN_COOLDOWN_MS = 60_000;

type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: State = 'closed';
  private failureCount = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly healthUrl: string;

  constructor(opts: { threshold?: number; cooldownMs?: number; healthUrl: string }) {
    this.threshold = opts.threshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? OPEN_COOLDOWN_MS;
    this.healthUrl = opts.healthUrl;
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  get currentState(): State {
    return this.state;
  }

  recordSuccess(): void {
    this.failureCount = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
      console.log('[tts] circuit closed — resuming generation');
    }
  }

  recordFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.threshold && this.state === 'closed') {
      this.state = 'open';
      this.openedAt = Date.now();
      console.log('[tts] circuit open — pausing generation');
    }
  }

  async waitUntilClosed(signal: AbortSignal): Promise<boolean> {
    while (this.state !== 'closed') {
      if (signal.aborted) return false;

      if (this.state === 'open') {
        const elapsed = Date.now() - this.openedAt;
        const remaining = this.cooldownMs - elapsed;
        if (remaining > 0) {
          await sleep(Math.min(remaining, 5000), signal);
          if (signal.aborted) return false;
          continue;
        }
        this.state = 'half-open';
        console.log('[tts] circuit half-open — probing health');
      }

      if (this.state === 'half-open') {
        const healthy = await this.probeHealth();
        if (healthy) {
          this.state = 'closed';
          this.failureCount = 0;
          console.log('[tts] circuit closed — resuming generation');
          return true;
        } else {
          this.state = 'open';
          this.openedAt = Date.now();
          console.log('[tts] circuit still unhealthy — reopening');
        }
      }
    }
    return true;
  }

  private async probeHealth(): Promise<boolean> {
    try {
      const res = await fetch(this.healthUrl, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
