/**
 * Load Balancer for TrucVPN share exits.
 * Balances new connections across multiple exits by load and latency.
 */

export interface ExitNode {
  id: string;
  host: string;
  port: number;
  currentLoad: number;   // active connections
  maxLoad: number;
  latencyMs: number;
}

export interface BalancerConfig {
  strategy: 'round-robin' | 'least-loaded' | 'lowest-latency';
  maxRetries: number;
  healthCheckIntervalMs: number;
}

const DEFAULT_CONFIG: BalancerConfig = {
  strategy: 'least-loaded',
  maxRetries: 3,
  healthCheckIntervalMs: 30000,
};

export class LoadBalancer {
  private exits: ExitNode[] = [];
  private config: BalancerConfig;
  private rrIndex = 0;

  constructor(config: Partial<BalancerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  addExit(exit: ExitNode): void {
    this.exits.push(exit);
  }

  removeExit(id: string): void {
    this.exits = this.exits.filter(e => e.id !== id);
  }

  getExits(): ExitNode[] {
    return [...this.exits];
  }

  selectExit(): ExitNode | null {
    const available = this.exits.filter(e => e.currentLoad < e.maxLoad);
    if (available.length === 0) return null;

    switch (this.config.strategy) {
      case 'round-robin':
        return this.selectRoundRobin(available);
      case 'least-loaded':
        return this.selectLeastLoaded(available);
      case 'lowest-latency':
        return this.selectLowestLatency(available);
      default:
        return this.selectLeastLoaded(available);
    }
  }

  private selectRoundRobin(available: ExitNode[]): ExitNode {
    const exit = available[this.rrIndex % available.length];
    this.rrIndex++;
    return exit;
  }

  private selectLeastLoaded(available: ExitNode[]): ExitNode {
    return available.reduce((a, b) =>
      (a.currentLoad / a.maxLoad) < (b.currentLoad / b.maxLoad) ? a : b
    );
  }

  private selectLowestLatency(available: ExitNode[]): ExitNode {
    return available.reduce((a, b) => a.latencyMs < b.latencyMs ? a : b);
  }

  getStats(): { total: number; available: number; strategy: string } {
    const available = this.exits.filter(e => e.currentLoad < e.maxLoad).length;
    return {
      total: this.exits.length,
      available,
      strategy: this.config.strategy,
    };
  }
}
