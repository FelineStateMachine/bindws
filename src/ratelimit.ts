// Per-connection token buckets with the retry hint clients understand:
// "rate-limited: quota exceeded; retry in Ns".

export class Bucket {
  private tokens: number;
  private last = Date.now();

  constructor(private perMinute: number) {
    this.tokens = perMinute;
  }

  // take returns "" if allowed, else the NIP-01 reason with a retry hint.
  take(perMinute = this.perMinute): string {
    this.perMinute = perMinute;
    const now = Date.now();
    this.tokens = Math.min(perMinute, this.tokens + ((now - this.last) / 60_000) * perMinute);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return "";
    }
    const wait = Math.ceil(((1 - this.tokens) / perMinute) * 60);
    return `rate-limited: quota exceeded; retry in ${Math.max(wait, 1)}s`;
  }
}
