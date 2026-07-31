/**
 * Multi-hop exit routing with ordered preference and automatic failover.
 */

export interface HopConfig {
  id: string;
  host: string;
  port: number;
  priority: number; // lower = preferred
}

export interface HopStatus {
  hop: HopConfig;
  active: boolean;
  latencyMs: number;
  failures: number;
}

export class MultiHopRouter {
  private hops: HopConfig[] = [];
  private statuses: Map<string, HopStatus> = new Map();
  private currentHopId: string | null = null;
  private maxFailures = 3;

  constructor(maxFailures = 3) {
    this.maxFailures = maxFailures;
  }

  addHop(hop: HopConfig): void {
    this.hops.push(hop);
    this.hops.sort((a, b) => a.priority - b.priority);
    this.statuses.set(hop.id, {
      hop,
      active: true,
      latencyMs: 0,
      failures: 0,
    });
  }

  removeHop(id: string): void {
    this.hops = this.hops.filter(h => h.id !== id);
    this.statuses.delete(id);
    if (this.currentHopId === id) {
      this.currentHopId = null;
    }
  }

  getActiveHop(): HopStatus | null {
    if (!this.currentHopId) return null;
    return this.statuses.get(this.currentHopId) || null;
  }

  selectHop(): HopConfig | null {
    for (const hop of this.hops) {
      const status = this.statuses.get(hop.id);
      if (status && status.failures < this.maxFailures) {
        this.currentHopId = hop.id;
        return hop;
      }
    }
    // All hops exhausted — reset failures and try again
    this.resetFailures();
    const firstHop = this.hops[0];
    if (firstHop) {
      this.currentHopId = firstHop.id;
      return firstHop;
    }
    return null;
  }

  recordFailure(hopId?: string): void {
    const id = hopId || this.currentHopId;
    if (!id) return;
    const status = this.statuses.get(id);
    if (status) {
      status.failures++;
      if (status.failures >= this.maxFailures) {
        status.active = false;
      }
    }
  }

  recordSuccess(hopId?: string, latencyMs = 0): void {
    const id = hopId || this.currentHopId;
    if (!id) return;
    const status = this.statuses.get(id);
    if (status) {
      status.failures = 0;
      status.active = true;
      status.latencyMs = latencyMs;
    }
  }

  resetFailures(): void {
    for (const [, status] of this.statuses) {
      status.failures = 0;
      status.active = true;
    }
  }

  getStatusReport(): { activeHop: string | null; hops: HopStatus[] } {
    return {
      activeHop: this.currentHopId,
      hops: Array.from(this.statuses.values()),
    };
  }

  getHopChain(): HopConfig[] {
    return [...this.hops];
  }
}
