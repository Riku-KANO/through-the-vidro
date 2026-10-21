/**
 * The last `size` samples, with allocation-free statistics: sorting copies them into a scratch buffer (insertion
 * sort), which is cheap for the small windows perf/ uses (a few to a few dozen samples) and does not allocate.
 */
export class RollingWindow {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private len = 0;
  private idx = 0;

  constructor(size: number) {
    this.values = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }

  get full(): boolean {
    return this.len === this.values.length;
  }

  push(v: number): void {
    this.values[this.idx] = v;
    this.idx = (this.idx + 1) % this.values.length;
    this.len = Math.min(this.len + 1, this.values.length);
  }

  mean(): number {
    let sum = 0;
    for (let i = 0; i < this.len; i++) sum += this.values[i] ?? 0;
    return this.len ? sum / this.len : 0;
  }

  /** The middle sample (the upper one of the two for an even count); 0 when empty. */
  median(): number {
    if (this.len === 0) return 0;
    return this.sorted()[this.len >> 1] ?? 0;
  }

  /** Nearest-rank quantile, q in [0, 1] (the same rank as percentile() in core/bench.ts); 0 when empty. */
  quantile(q: number): number {
    if (this.len === 0) return 0;
    const rank = Math.ceil(Math.min(1, Math.max(0, q)) * this.len) - 1;
    return this.sorted()[Math.max(0, rank)] ?? 0;
  }

  private sorted(): Float64Array {
    const n = this.len;
    const s = this.scratch;
    for (let i = 0; i < n; i++) s[i] = this.values[i] ?? 0;
    for (let i = 1; i < n; i++) {
      const v = s[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && (s[j] ?? 0) > v) {
        s[j + 1] = s[j] ?? 0;
        j--;
      }
      s[j + 1] = v;
    }
    return s;
  }
}
