"use strict";

/**
 * Kill-switch guard — blocks non-proxy traffic when the VPN should be
 * protecting all connections.
 *
 * Two layers:
 *  1. Proxy guard (in-process, no privileges): checks every connection
 *     before it leaves the machine and refuses direct dials.
 *  2. OS firewall rules (see firewall.js): blocks traffic that never
 *     touches the proxy (QUIC/HTTP3, UDP, other processes).
 */

/**
 * Create a kill-switch guard.  Returns an object with:
 *  - guard(exit, targetHost, targetPort) → { allowed, reason }
 *  - check(exit) → { enforcing, reason }
 *  - stats() → { blocked_connections, enforcing }
 */
function createKillSwitch({ enabled = false } = {}) {
  let blocked = 0;

  /** Check if the exit will carry traffic through a tunnel (safe). */
  function isTunneled(exit) {
    if (!exit) return false;
    const proto = String(exit.protocol || "direct").toLowerCase();
    return proto !== "direct";
  }

  /**
   * Called before a connection is opened.  Returns:
   *  { allowed: true }  → proceed
   *  { allowed: false, reason: "…" } → block
   */
  function guard(exit, targetHost, targetPort) {
    if (!enabled) {
      return { allowed: true };
    }

    // Direct exit or no exit = traffic leaves the machine unprotected
    if (!isTunneled(exit)) {
      blocked += 1;
      const dest = targetHost ? ` to ${targetHost}:${targetPort || "?"}` : "";
      const exitId = exit ? exit.id || "direct" : "none";
      return {
        allowed: false,
        reason: `kill switch: non-proxy traffic${dest} blocked — exit "${exitId}" is not tunneled`,
        code: "KILL_SWITCH"
      };
    }

    return { allowed: true };
  }

  /**
   * Pre-flight check (call before opening listeners) — returns
   * { enforcing, reason } so callers can refuse to start at all.
   */
  function check(exit) {
    if (!enabled) {
      return { enforcing: false, reason: "kill switch disabled" };
    }
    if (!isTunneled(exit)) {
      return {
        enforcing: true,
        reason: `kill switch: exit "${exit ? exit.id || "none" : "none"}" is not tunneled — refusing to connect without protection`
      };
    }
    return { enforcing: true, reason: "kill switch armed and tunneled" };
  }

  /** Stats for status/dashboard. */
  function stats() {
    return {
      blocked_connections: blocked,
      enforcing: enabled
    };
  }

  return { guard, check, stats };
}

module.exports = { createKillSwitch };
