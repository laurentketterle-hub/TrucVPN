"use strict";

/**
 * Multi-User Share Load Balancer — distributes user sessions across exits.
 *
 * Strategies:
 *   - round-robin       Cycle through exits in order
 *   - least-loaded      Prefer exit with lowest current load metric
 *   - weighted-latency  Weight by inverse latency (lower = more users)
 *   - region-affinity   Route to user's preferred region; fallback round-robin
 */

class MultiUserLoadBalancer {
  constructor({
    exits = [],
    strategy = "round-robin",
    stickySessions = true,
    healthCheckIntervalMs = 30000,
  } = {}) {
    this._exits = exits.filter((e) => e.protocol !== "direct");
    this._directExit = exits.find((e) => e.protocol === "direct") || {
      id: "direct-local-fallback",
      name: "Direct (fallback)",
      region: "local",
      protocol: "direct",
      load: 0,
      latency_ms: 1,
    };
    this._strategy = String(strategy).toLowerCase();
    this._sticky = Boolean(stickySessions);
    this._healthInterval = healthCheckIntervalMs;

    // round-robin index
    this._rrIndex = 0;

    // user -> exit.id mapping (sticky)
    this._userMap = new Map();

    // per-exit user count (tracked for least-loaded)
    this._exitUserCount = new Map();
    for (const e of this._exits) {
      this._exitUserCount.set(e.id, 0);
    }

    // unhealthy exits (temporarily excluded)
    this._unhealthy = new Set();
    this._healthTimers = new Map();
  }

  /** Available (healthy) residential exits. */
  _healthyExits() {
    return this._exits.filter((e) => !this._unhealthy.has(e.id));
  }

  /** Assign an exit to a user session. */
  assignExitForUser(userId, preferredRegion) {
    // Sticky: return existing assignment if still healthy
    if (this._sticky && this._userMap.has(userId)) {
      const exitId = this._userMap.get(userId);
      const exit = this._exits.find((e) => e.id === exitId);
      if (exit && !this._unhealthy.has(exit.id)) {
        return { exit, isFallback: false, assignedAt: new Date().toISOString() };
      }
    }

    const healthy = this._healthyExits();
    if (healthy.length === 0) {
      return {
        exit: this._directExit,
        isFallback: true,
        assignedAt: new Date().toISOString(),
      };
    }

    let chosen;
    switch (this._strategy) {
      case "least-loaded":
        chosen = this._pickLeastLoaded(healthy);
        break;
      case "weighted-latency":
        chosen = this._pickWeightedLatency(healthy);
        break;
      case "region-affinity":
        chosen = this._pickRegionAffinity(healthy, preferredRegion);
        break;
      case "round-robin":
      default:
        chosen = this._pickRoundRobin(healthy);
        break;
    }

    // Track assignment
    if (this._sticky) {
      this._userMap.set(userId, chosen.id);
    }
    const count = this._exitUserCount.get(chosen.id) || 0;
    this._exitUserCount.set(chosen.id, count + 1);

    return { exit: chosen, isFallback: false, assignedAt: new Date().toISOString() };
  }

  /** Release a user's assignment (on disconnect). */
  releaseUser(userId) {
    if (this._userMap.has(userId)) {
      const exitId = this._userMap.get(userId);
      const count = this._exitUserCount.get(exitId) || 1;
      this._exitUserCount.set(exitId, Math.max(0, count - 1));
      this._userMap.delete(userId);
    }
  }

  /** Mark an exit as unhealthy; it will be excluded until re-check. */
  markUnhealthy(exitId) {
    this._unhealthy.add(exitId);
    if (!this._healthTimers.has(exitId)) {
      this._healthTimers.set(
        exitId,
        setTimeout(() => {
          this._unhealthy.delete(exitId);
          this._healthTimers.delete(exitId);
        }, this._healthInterval)
      );
    }
  }

  /** Get load balancer stats. */
  getStats() {
    return {
      totalUsers: this._userMap.size,
      exitsInRotation: this._healthyExits().length,
      unhealthyExits: this._unhealthy.size,
      strategy: this._strategy,
      stickySessions: this._sticky,
    };
  }

  // --- private pick helpers ---

  _pickRoundRobin(healthy) {
    const idx = this._rrIndex % healthy.length;
    this._rrIndex = (this._rrIndex + 1) % healthy.length;
    return healthy[idx];
  }

  _pickLeastLoaded(healthy) {
    return healthy.slice().sort((a, b) => {
      const ca = this._exitUserCount.get(a.id) || 0;
      const cb = this._exitUserCount.get(b.id) || 0;
      if (ca !== cb) return ca - cb;
      return (a.load || 0) - (b.load || 0);
    })[0];
  }

  _pickWeightedLatency(healthy) {
    // Build weighted pool: inverse latency = higher weight
    const totalWeight = healthy.reduce((sum, e) => {
      return sum + 1 / Math.max(Number(e.latency_ms) || 1, 1);
    }, 0);
    let r = Math.random() * totalWeight;
    for (const e of healthy) {
      const w = 1 / Math.max(Number(e.latency_ms) || 1, 1);
      r -= w;
      if (r <= 0) return e;
    }
    return healthy[healthy.length - 1];
  }

  _pickRegionAffinity(healthy, preferredRegion) {
    if (preferredRegion) {
      const regionExits = healthy.filter(
        (e) => String(e.region || "").toLowerCase() === String(preferredRegion).toLowerCase()
      );
      if (regionExits.length > 0) {
        return this._pickRoundRobin(regionExits);
      }
    }
    return this._pickRoundRobin(healthy);
  }
}

/** Factory: create a load balancer from TrucVPN config. */
function createLoadBalancer(config, exits) {
  return new MultiUserLoadBalancer({
    exits: exits || [],
    strategy: config.lbStrategy || "round-robin",
    stickySessions: config.lbStickySessions !== false,
  });
}

module.exports = { MultiUserLoadBalancer, createLoadBalancer };
