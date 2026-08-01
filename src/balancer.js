"use strict";

/**
 * Multi-User Share Load Balancer — distribute connections across exits.
 * Implements #16 [200 MRG] Feature: multi-user share load balancer across exits.
 *
 * Strategies:
 *   - "round-robin"          — cycle through exits in order
 *   - "least-connections"    — route to exit with fewest active connections
 *   - "weighted"             — weight by (1 - load) so least-loaded exits get more traffic
 *   - "latency-weighted"     — prefer lower latency exits
 *   - "adaptive"             — combine latency + load + connection count (default)
 *
 * Maintains per-exit connection tracking for real-time load decisions.
 */

const EventEmitter = require("node:events");

/**
 * @typedef {{ id: string, host: string, port: number, load?: number, latency_ms?: number, maxConnections?: number }} Exit
 */

class LoadBalancer extends EventEmitter {
  /**
   * @param {{ strategy?: string, exits?: Exit[], maxPerExit?: number }} opts
   */
  constructor(opts = {}) {
    super();
    this.strategy = opts.strategy || "adaptive";
    this.exits = opts.exits || [];
    this.maxPerExit = opts.maxPerExit || 100;
    this._connections = new Map(); // exitId → active connection count
    this._index = 0; // round-robin cursor
    this._stats = new Map(); // exitId → { routed, failed, totalLatencyMs }

    for (const exit of this.exits) {
      this._connections.set(exit.id, 0);
      this._stats.set(exit.id, { routed: 0, failed: 0, totalLatencyMs: 0 });
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Pick the best exit for a new connection based on the active strategy.
   *
   * @param {{ preferredRegion?: string, excludeExits?: string[] }} hints
   * @returns {Exit|null}
   */
  pickExit(hints = {}) {
    const pool = this._filteredPool(hints.excludeExits || []);
    if (pool.length === 0) return null;

    switch (this.strategy) {
      case "round-robin":
        return this._roundRobin(pool);

      case "least-connections":
        return this._leastConnections(pool);

      case "weighted":
        return this._weighted(pool);

      case "latency-weighted":
        return this._latencyWeighted(pool);

      case "adaptive":
      default:
        return this._adaptive(pool, hints.preferredRegion);
    }
  }

  /**
   * Record a connection opened on an exit.
   *
   * @param {string} exitId
   */
  openConnection(exitId) {
    const current = this._connections.get(exitId) || 0;
    this._connections.set(exitId, current + 1);
    this._incrementStat(exitId, "routed");
  }

  /**
   * Record a connection closed on an exit.
   *
   * @param {string} exitId
   */
  closeConnection(exitId) {
    const current = this._connections.get(exitId) || 0;
    this._connections.set(exitId, Math.max(0, current - 1));
  }

  /**
   * Record a failed connection attempt on an exit.
   *
   * @param {string} exitId
   */
  recordFailure(exitId) {
    this._incrementStat(exitId, "failed");
  }

  /**
   * Record latency for a connection on an exit.
   *
   * @param {string} exitId
   * @param {number} latencyMs
   */
  recordLatency(exitId, latencyMs) {
    const stats = this._stats.get(exitId);
    if (stats) {
      stats.totalLatencyMs += latencyMs;
    }
  }

  /**
   * Update the exit pool (e.g., after live share discovery).
   *
   * @param {Exit[]} exits
   */
  updateExits(exits) {
    // Preserve connection counts for existing exits
    const newExits = [];
    for (const exit of exits) {
      if (!this._connections.has(exit.id)) {
        this._connections.set(exit.id, 0);
        this._stats.set(exit.id, {
          routed: 0,
          failed: 0,
          totalLatencyMs: 0,
        });
      }
      newExits.push(exit);
    }
    this.exits = newExits;
  }

  /**
   * Change balancing strategy at runtime.
   *
   * @param {string} strategy
   */
  setStrategy(strategy) {
    const valid = [
      "round-robin",
      "least-connections",
      "weighted",
      "latency-weighted",
      "adaptive",
    ];
    if (!valid.includes(strategy)) {
      throw new Error(
        `invalid strategy: ${strategy}. Valid: ${valid.join(", ")}`
      );
    }
    this.strategy = strategy;
    return this.strategy;
  }

  /**
   * Get current balancer stats for dashboard/monitoring.
   *
   * @returns {{ strategy: string, totalExits: number, activeConnections: number, perExit: object[] }}
   */
  snapshot() {
    let activeConnections = 0;
    const perExit = [];

    for (const [exitId, conns] of this._connections) {
      activeConnections += conns;
      const stats = this._stats.get(exitId) || {
        routed: 0,
        failed: 0,
        totalLatencyMs: 0,
      };
      const exit = this.exits.find((e) => e.id === exitId);
      perExit.push({
        id: exitId,
        name: exit ? exit.name : exitId,
        activeConnections: conns,
        routed: stats.routed,
        failed: stats.failed,
        avgLatencyMs:
          stats.routed > 0
            ? Math.round(stats.totalLatencyMs / stats.routed)
            : null,
        load: exit ? exit.load : null,
        protocol: exit ? exit.protocol : null,
        region: exit ? exit.region : null,
      });
    }

    // Sort by active connections desc
    perExit.sort((a, b) => b.activeConnections - a.activeConnections);

    return {
      strategy: this.strategy,
      totalExits: this.exits.length,
      activeConnections,
      perExit,
    };
  }

  // ─── Internal Strategies ───────────────────────────────────────────────

  _filteredPool(excludeIds) {
    const exclude = new Set(excludeIds);
    return this.exits.filter(
      (e) =>
        !exclude.has(e.id) &&
        (this._connections.get(e.id) || 0) < this.maxPerExit
    );
  }

  _roundRobin(pool) {
    if (pool.length === 0) return null;
    this._index = (this._index + 1) % pool.length;
    return pool[this._index];
  }

  _leastConnections(pool) {
    return pool
      .slice()
      .sort(
        (a, b) =>
          (this._connections.get(a.id) || 0) -
          (this._connections.get(b.id) || 0)
      )[0];
  }

  _weighted(pool) {
    // Weight by (1 - load): exits with lower load get more traffic
    const weighted = pool.map((e) => ({
      exit: e,
      weight: Math.max(0.01, 1 - (Number(e.load) || 0)),
    }));

    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    let r = Math.random() * totalWeight;

    for (const { exit, weight } of weighted) {
      r -= weight;
      if (r <= 0) return exit;
    }
    return weighted[weighted.length - 1].exit;
  }

  _latencyWeighted(pool) {
    // Prefer lower latency, with randomness to avoid thundering herd
    return pool
      .slice()
      .sort(
        (a, b) =>
          Number(a.latency_ms || 9999) +
          (this._connections.get(a.id) || 0) * 10 -
          (Number(b.latency_ms || 9999) +
            (this._connections.get(b.id) || 0) * 10)
      )[0];
  }

  _adaptive(pool, preferredRegion) {
    // Score each exit: lower latency → better, lower load → better, fewer connections → better
    const scored = pool.map((e) => {
      const latency = Number(e.latency_ms || 200);
      const load = Number(e.load || 0.5);
      const conns = this._connections.get(e.id) || 0;
      const failureRate =
        (this._stats.get(e.id)?.failed || 0) /
        Math.max(1, (this._stats.get(e.id)?.routed || 0));

      // Composite score (lower = better):
      //   latency (normalized 0-1) * 0.6
      //   + load * 0.2
      //   + conns/maxConns * 0.15
      //   + failureRate * 0.05
      const latencyScore = Math.min(1, latency / 500);
      const connScore = Math.min(1, conns / this.maxPerExit);
      const score =
        latencyScore * 0.6 +
        load * 0.2 +
        connScore * 0.15 +
        failureRate * 0.05;

      // Bonus for preferred region
      const regionBonus =
        preferredRegion &&
        String(e.region || "").toLowerCase() ===
          String(preferredRegion).toLowerCase()
          ? -0.2
          : 0;

      return { exit: e, score: score + regionBonus };
    });

    scored.sort((a, b) => a.score - b.score);
    return scored[0].exit;
  }

  _incrementStat(exitId, field) {
    const stats = this._stats.get(exitId);
    if (stats) {
      stats[field] = (stats[field] || 0) + 1;
    }
  }
}

module.exports = { LoadBalancer };
