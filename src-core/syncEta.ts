/** Estimates only from fully saved checkpoints in the current foreground run. */
export class SyncEtaEstimator {
  private epoch = 0;
  private active = true;
  private samples: Array<{ rows: number; elapsedMs: number }> = [];

  begin(now = performance.now()) {
    return { epoch: this.epoch, startedAt: now };
  }

  complete(batch: ReturnType<SyncEtaEstimator["begin"]>, rows: number, now = performance.now()) {
    const elapsedMs = now - batch.startedAt;
    if (!this.active || batch.epoch !== this.epoch || rows <= 0 || !Number.isFinite(rows) || elapsedMs <= 0 || !Number.isFinite(elapsedMs)) return;
    this.samples.push({ rows, elapsedMs });
    if (this.samples.length > 5) this.samples.shift();
  }

  estimateSeconds(remaining: number): number | undefined {
    if (!this.active || this.samples.length < 2 || !Number.isFinite(remaining) || remaining <= 0) return;
    const elapsedMs = this.samples.reduce((sum, sample) => sum + sample.elapsedMs, 0);
    if (elapsedMs < 30_000) return;
    const rows = this.samples.reduce((sum, sample) => sum + sample.rows, 0);
    return Math.ceil(remaining * elapsedMs / rows / 1000);
  }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.reset();
  }

  reset() {
    this.epoch++;
    this.samples = [];
  }
}
