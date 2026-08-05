"use strict";

const os = require("node:os");
const { execSync } = require("node:child_process");

/**
 * OS firewall helper for kill-switch — builds a plan of rules that block
 * all outbound traffic except loopback, the exit, and share discovery.
 *
 * Rules are PRINT-ONLY by default.  --apply / --revert are explicit.
 * Incomplete plans (unresolvable exit host) refuse to apply.
 */

const RULE_NAME = "TrucVPN Kill Switch";

/**
 * Build a firewall plan for the given exits.  Returns:
 *  { platform, commands: [...], revert: [...], complete: bool }
 */
function buildPlan({ exits = [], allowLan = false, allowDns = false, platform } = {}) {
  const p = platform || os.platform(); // win32 | linux | darwin

  if (p === "win32") {
    return buildWindowsPlan({ exits, allowLan, allowDns });
  }
  if (p === "linux") {
    return buildNftablesPlan({ exits, allowLan, allowDns });
  }
  if (p === "darwin") {
    return buildPfPlan({ exits, allowLan, allowDns });
  }

  return { platform: p, commands: [], revert: [], complete: false,
    error: `unsupported platform: ${p}` };
}

function buildWindowsPlan({ exits, allowLan, allowDns }) {
  const commands = [];
  const revertCmd = [];

  // Default inbound/outbound policy to block outbound
  commands.push(`netsh advfirewall set currentprofile firewallpolicy blockinbound,blockoutbound`);
  revertCmd.push(`netsh advfirewall set currentprofile firewallpolicy blockinbound,allowoutbound`);

  // Remove any existing TrucVPN rules
  commands.push(`netsh advfirewall firewall delete rule name="${RULE_NAME}"`);
  revertCmd.push(`netsh advfirewall firewall delete rule name="${RULE_NAME}"`);

  // Allow loopback
  commands.push(
    `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=any remoteip=127.0.0.0/8`
  );

  // Allow DNS if opted in
  if (allowDns) {
    commands.push(
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=udp remoteport=53`
    );
    commands.push(
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=tcp remoteport=53`
    );
  }

  // Allow LAN if opted in
  if (allowLan) {
    commands.push(
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=any remoteip=10.0.0.0/8`
    );
    commands.push(
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=any remoteip=172.16.0.0/12`
    );
    commands.push(
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=any remoteip=192.168.0.0/16`
    );
  }

  // Allow each exit
  let complete = true;
  for (const exit of exits) {
    if (!exit.host) continue;
    const ip = resolveHost(exit.host);
    if (!ip) {
      complete = false;
      continue;
    }
    const port = exit.port ? ` remoteport=${exit.port}` : "";
    commands.push(
      `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=out action=allow protocol=tcp remoteip=${ip}${port}`
    );
  }

  if (exits.length === 0) complete = false;

  return {
    platform: "win32",
    commands,
    revert: revertCmd,
    complete,
    ruleName: RULE_NAME
  };
}

function buildNftablesPlan({ exits, allowLan, allowDns }) {
  const lines = [];
  const tableName = "trucvpn_ks";

  lines.push(`nft add table inet ${tableName}`);
  lines.push(`nft add chain inet ${tableName} output { type filter hook output priority 0\; policy accept\; }`);

  // Allow loopback
  lines.push(`nft add rule inet ${tableName} output oif lo accept`);

  if (allowDns) {
    lines.push(`nft add rule inet ${tableName} output udp dport 53 accept`);
    lines.push(`nft add rule inet ${tableName} output tcp dport 53 accept`);
  }

  if (allowLan) {
    lines.push(`nft add rule inet ${tableName} output ip daddr 10.0.0.0/8 accept`);
    lines.push(`nft add rule inet ${tableName} output ip daddr 172.16.0.0/12 accept`);
    lines.push(`nft add rule inet ${tableName} output ip daddr 192.168.0.0/16 accept`);
  }

  let complete = true;
  for (const exit of exits) {
    if (!exit.host) continue;
    const ip = resolveHost(exit.host);
    if (!ip) {
      complete = false;
      continue;
    }
    const portFilter = exit.port ? ` tcp dport ${exit.port}` : "";
    lines.push(`nft add rule inet ${tableName} output ip daddr ${ip}${portFilter} accept`);
  }

  if (exits.length === 0) complete = false;

  // Final drop
  lines.push(`nft add rule inet ${tableName} output drop`);

  const revert = [`nft delete table inet ${tableName}`];

  return {
    platform: "linux",
    commands: lines,
    revert,
    complete,
    tableName
  };
}

function buildPfPlan({ exits, allowLan, allowDns }) {
  const rules = [];
  const anchorName = "trucvpn.ks";

  rules.push(`nat-anchor "${anchorName}"`);
  rules.push(`rdr-anchor "${anchorName}"`);
  rules.push(`anchor "${anchorName}"`);
  rules.push(`load anchor "${anchorName}" from "/etc/pf.anchors/${anchorName}"`);

  let complete = true;
  for (const exit of exits) {
    if (!exit.host) continue;
    const ip = resolveHost(exit.host);
    if (!ip) {
      complete = false;
      continue;
    }
    const port = exit.port ? ` port ${exit.port}` : "";
    rules.push(`pass out proto tcp to ${ip}${port}`);
  }

  if (exits.length === 0) complete = false;
  rules.push("block return out proto tcp all");
  rules.push("block return out proto udp all");

  const revert = [`pfctl -a "${anchorName}" -F all`];

  return {
    platform: "darwin",
    commands: rules,
    revert,
    complete,
    anchorName
  };
}

/** Try to resolve a hostname to IPv4.  Returns null on failure. */
function resolveHost(host) {
  // If already an IP, return as-is
  if (/^[\d.]+$/.test(host)) return host;
  try {
    // Simple dns.lookup
    const dns = require("node:dns");
    // Synchronous for plan building simplicity
    // We use a trick: execSync nslookup for cross-platform
    const result = execSync(`nslookup ${host} 2>&1`, { timeout: 3000, encoding: "utf8" });
    const match = result.match(/Address(?:es)?:\s+([\d.]+)/g);
    if (match) {
      const ips = match.map(m => m.match(/([\d.]+)$/)[1]).filter(ip => ip !== "127.0.0.1");
      return ips[0] || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Execute a plan safely.  Returns { ok, results, ... }
 * Nothing runs without explicit confirmation.
 */
function executePlan(plan, { apply = false, revert = false, dryRun = false } = {}) {
  if (!apply && !revert && !dryRun) {
    return {
      ok: false,
      error: "NOOP: use --apply or --revert to execute, or omit for print-only preview",
      plan
    };
  }

  if (apply && !plan.complete) {
    return {
      ok: false,
      error: "REFUSED: plan is incomplete (unresolvable exit hosts). " +
             "Applying would block the exit itself. Fix host resolution or use --revert to clean up.",
      plan
    };
  }

  const cmds = revert ? plan.revert : plan.commands;
  const results = [];

  for (const cmd of cmds) {
    if (dryRun) {
      results.push({ cmd, dryRun: true });
      continue;
    }
    try {
      const out = execSync(cmd, { timeout: 10000, encoding: "utf8", stdio: "pipe" });
      results.push({ cmd, ok: true, output: out.trim() });
    } catch (err) {
      results.push({ cmd, ok: false, error: err.message });
      return {
        ok: false,
        error: `Command failed: ${cmd}\n${err.message}`,
        results,
        plan,
        revertAvailable: revert ? false : plan.revert
      };
    }
  }

  return { ok: true, results, plan };
}

module.exports = { buildPlan, executePlan, RULE_NAME };
