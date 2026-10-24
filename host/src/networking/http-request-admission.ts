interface WaitingRequest {
  limit: number;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (release: (() => void) | null) => void;
  reject: (error: Error) => void;
}

export class HttpRequestAdmission {
  private active = 0;
  private readonly waiting: WaitingRequest[] = [];
  private failure: Error | undefined;

  constructor(private readonly maxWaiting = 128) {}

  acquire(limit: number, timeoutMs: number): Promise<(() => void) | null> {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 0x7fffffff) {
      return Promise.reject(new RangeError("HTTP admission limit and timeout are invalid"));
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (timeoutMs === 0) return Promise.resolve(null);
    if (this.waiting.length === 0 && this.active < limit) return Promise.resolve(this.admit());
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.reject(new Error("in-kernel HTTP admission queue is full"));
    }
    return new Promise((resolve, reject) => {
      const request: WaitingRequest = { limit, deadline: Date.now() + timeoutMs,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(request);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            resolve(null);
            this.drain();
          }
        }, timeoutMs), resolve, reject };
      this.waiting.push(request);
    });
  }

  close(error: Error): void {
    this.failure ??= error;
    for (const request of this.waiting.splice(0)) {
      clearTimeout(request.timer);
      request.reject(this.failure);
    }
  }

  private admit(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.failure === undefined && this.waiting.length !== 0) {
      const request = this.waiting[0]!;
      if (request.deadline <= Date.now()) {
        this.waiting.shift();
        clearTimeout(request.timer);
        request.resolve(null);
      } else if (this.active < request.limit) {
        this.waiting.shift();
        clearTimeout(request.timer);
        request.resolve(this.admit());
      } else return;
    }
  }
}
