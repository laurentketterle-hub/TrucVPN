"use strict";

/**
 * Multi-Hop Exit Chain — route traffic through multiple exits sequentially.
 * Implements #7 [100 MRG] Feature: multi-hop exit preference (share + fallback chain).
 *
 * Supports:
 *   - Ordered chain: [exit-A, exit-B, exit-C] — connect through each in order
 *   - Failover: if one hop is unreachable, try next in chain
 *   - Share-based discovery: chains can include MRGMinner share exits
 *
 * Chain format (config):
 *   {
 *     "multiHopChain": [
 *       { "exitId": "mock-us-sfo", "role": "entry" },
 *       { "exitId": "mock-eu-fra", "role": "middle" },
 *       { "exitId": "mock-vn-hcm", "role": "exit" }
 *     ],
 *     "multiHopFallbackStrategy": "next-in-chain" | "direct" | "abort"
 *   }
 */

const { connectViaExit } = require("./proxy/upstream");
const { findExit } = require("./catalog");

/**
 * Connect to target through a chain of exits.
 *
 * @param {Array<object>} chain - Ordered list of exit objects
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {{ timeoutMs?: number, fallbackStrategy?: string, onHop?: Function }} opts
 * @returns {Promise<{socket: net.Socket, hops: Array<{exitId: string, latencyMs: number}>}>}
 */
async function connectViaChain(chain, targetHost, targetPort, opts = {}) {
  if (!chain || chain.length === 0) {
    throw new Error("multi-hop chain is empty");
  }

  const timeoutMs = opts.timeoutMs || 30000;
  const fallbackStrategy = opts.fallbackStrategy || "next-in-chain";
  const hops = [];

  // Single hop — delegate to standard connectViaExit
  if (chain.length === 1) {
    const t0 = Date.now();
    const socket = await connectViaExit(chain[0], targetHost, targetPort, {
      timeoutMs,
    });
    hops.push({ exitId: chain[0].id, latencyMs: Date.now() - t0 });
    return { socket, hops };
  }

  // Multi-hop: tunnel through each exit sequentially
  let socket = null;

  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    const isLast = i === chain.length - 1;
    const t0 = Date.now();
    const nextTarget = isLast
      ? { host: targetHost, port: targetPort }
      : { host: chain[i + 1].host, port: chain[i + 1].port };

    try {
      socket = await connectViaExit(hop, nextTarget.host, nextTarget.port, {
        timeoutMs: Math.floor(timeoutMs / chain.length),
      });
      hops.push({ exitId: hop.id, latencyMs: Date.now() - t0 });
    } catch (err) {
      // Hop failed — apply fallback strategy
      if (fallbackStrategy === "direct") {
        // Fall back to direct connection for remaining hops
        const directExit = {
          id: "direct-fallback",
          protocol: "direct",
          name: "Direct (fallback)",
        };
        socket = await connectViaExit(
          directExit,
          nextTarget.host,
          nextTarget.port,
          { timeoutMs }
        );
        hops.push({
          exitId: "direct-fallback",
          latencyMs: Date.now() - t0,
        });
      } else if (fallbackStrategy === "abort") {
        throw new Error(
          `multi-hop chain failed at hop ${i + 1} (${hop.id}): ${err.message}`
        );
      }
      // "next-in-chain" — continue to next hop (implicit by loop)
      else {
        hops.push({
          exitId: `${hop.id}-failed`,
          latencyMs: Date.now() - t0,
        });
        // For non-last hops, try direct to next in chain
        if (!isLast) {
          continue;
        }
      }
    }
  }

  if (!socket) {
    throw new Error("multi-hop chain could not establish any connection");
  }

  return { socket, hops };
}

/**
 * Build a chain from an ordered list of exit IDs or region preferences.
 *
 * @param {Array<object>} exits - Full exit catalog
 * @param {Array<{exitId?: string, region?: string}>|string[]} chainDef
 * @returns {Array<object>}
 */
function buildChain(exits, chainDef) {
  if (!chainDef || chainDef.length === 0) {
    return [];
  }

  return chainDef
    .map((hop) => {
      if (typeof hop === "string") {
        return findExit(exits, hop);
      }
      if (hop.exitId) {
        return findExit(exits, hop.exitId);
      }
      if (hop.region) {
        // Find best exit in region
        const pool = exits.filter(
          (e) =>
            String(e.region || "").toLowerCase() ===
              String(hop.region).toLowerCase() && e.protocol !== "direct"
        );
        if (pool.length === 0) return null;
        return pool.sort(
          (a, b) =>
            Number(a.latency_ms || 9999) + Number(a.load || 0) * 100 -
            (Number(b.latency_ms || 9999) + Number(b.load || 0) * 100)
        )[0];
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * Validate a chain — check that no hop references itself and chain is < 6 hops.
 *
 * @param {Array<object>} chain
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateChain(chain) {
  const errors = [];

  if (!Array.isArray(chain)) {
    return { valid: false, errors: ["chain must be an array"] };
  }

  if (chain.length === 0) {
    errors.push("chain is empty");
  }

  if (chain.length > 5) {
    errors.push("chain exceeds maximum 5 hops (latency penalty)");
  }

  // Check for duplicate exits
  const ids = chain.map((e) => e.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    errors.push(`duplicate exit in chain: ${dupes.join(", ")}`);
  }

  // Check for direct-only mixed with proxy
  const hasDirect = chain.some((e) => e.protocol === "direct");
  const hasProxy = chain.some((e) => e.protocol !== "direct");
  if (hasDirect && hasProxy && chain.length > 1) {
    errors.push("mixing direct and proxy hops in a chain is not recommended");
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  connectViaChain,
  buildChain,
  validateChain,
};
