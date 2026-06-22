export class BackoffCalculator {
  private baseDelayMs: number;
  private multiplier: number;
  private maxDelayMs: number;
  private jitterFactor: number; // 0.1 means +/-10%
  private attempt: number;

  constructor({
    baseDelayMs = 1000,
    multiplier = 2,
    maxDelayMs = 120_000,
    jitterFactor = 0.1,
  } = {}) {
    this.baseDelayMs = baseDelayMs;
    this.multiplier = multiplier;
    this.maxDelayMs = maxDelayMs;
    this.jitterFactor = jitterFactor;
    this.attempt = 0;
  }

  /**
   * Returns the delay for the next attempt and increments attempt counter.
   */
  public nextDelay(): number {
    const exponential = this.baseDelayMs * Math.pow(this.multiplier, this.attempt);
    const capped = Math.min(exponential, this.maxDelayMs);
    // Apply jitter +/- jitterFactor proportion
    const jitter = capped * this.jitterFactor * (Math.random() * 2 - 1);
    this.attempt++;
    return Math.max(0, Math.round(capped + jitter));
  }

  /** Reset the attempt counter (e.g., after a successful request). */
  public reset(): void {
    this.attempt = 0;
  }
}
