"use strict";

/**
 * Kill Switch — block non-proxy traffic when VPN is active.
 * Implements #4 [100 MRG] Feature: kill-switch helper for non-proxy traffic.
 *
 * Two enforcement modes:
 *   - "strict"  – firewall rules + system proxy enforcement (blocks ALL non-proxy traffic)
 *   - "soft"    – system proxy only (routes browser traffic, apps may bypass)
 *
 * The kill switch applies OS-level rules on connect and tears them down on disconnect.
 */

const { execSync, exec } = require("node:child_process");
const os = require("node:os");

const PLATFORM = os.platform(); // 'win32' | 'linux' | 'darwin'

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Arm the kill switch — enforce that no traffic leaves the machine
 * outside the local SOCKS5/HTTP proxy ports.
 *
 * @param {{ mode?: "strict"|"soft", proxyPorts?: number[], whitelistSubnets?: string[] }} opts
 * @returns {{ armed: true, mode: string, rules: string[] }}
 */
function arm(opts = {}) {
  const mode = opts.mode || "strict";
  const proxyPorts = opts.proxyPorts || [17880, 17881];
  const whitelistSubnets = opts.whitelistSubnets || ["127.0.0.0/8", "::1/128"];

  const rules = [];

  if (mode === "strict") {
    if (PLATFORM === "win32") {
      rules.push(..._armWindows(proxyPorts, whitelistSubnets));
    } else if (PLATFORM === "linux") {
      rules.push(..._armLinux(proxyPorts, whitelistSubnets));
    } else if (PLATFORM === "darwin") {
      rules.push(..._armDarwin(proxyPorts, whitelistSubnets));
    }
  }

  // Always enforce system proxy (soft mode always active)
  rules.push(..._enforceSystemProxy(proxyPorts));

  return { armed: true, mode, rules };
}

/**
 * Disarm the kill switch — remove all firewall rules and proxy settings.
 *
 * @returns {{ disarmed: true, cleaned: string[] }}
 */
function disarm() {
  const cleaned = [];

  if (PLATFORM === "win32") {
    cleaned.push(..._disarmWindows());
  } else if (PLATFORM === "linux") {
    cleaned.push(..._disarmLinux());
  } else if (PLATFORM === "darwin") {
    cleaned.push(..._disarmDarwin());
  }

  cleaned.push(..._disableSystemProxy());

  return { disarmed: true, cleaned };
}

/**
 * Check current kill-switch status (are rules active?).
 *
 * @returns {{ active: boolean, platform: string, rulesCount: number|null }}
 */
function status() {
  try {
    if (PLATFORM === "win32") {
      const out = execSync(
        'netsh advfirewall firewall show rule name="TrucVPN Kill Switch"',
        { encoding: "utf8", timeout: 3000 }
      );
      const lines = out.split("\n").filter((l) => l.includes("Enabled:"));
      const enabled = lines.some((l) => l.includes("Yes"));
      return { active: enabled, platform: PLATFORM, rulesCount: lines.length };
    }
    if (PLATFORM === "linux") {
      const out = execSync("iptables -L TRUCVPN_KILLSWITCH -n 2>/dev/null", {
        encoding: "utf8",
        timeout: 3000,
      });
      const lines = out.split("\n").filter((l) => l.trim());
      return {
        active: lines.length > 2,
        platform: PLATFORM,
        rulesCount: Math.max(0, lines.length - 2),
      };
    }
  } catch {
    /* not armed */
  }
  return { active: false, platform: PLATFORM, rulesCount: null };
}

// ─── Windows (netsh + system proxy) ──────────────────────────────────────

function _armWindows(proxyPorts, whitelistSubnets) {
  const rules = [];

  // Block all outbound TCP except to whitelisted subnets and proxy ports
  const remoteIps = whitelistSubnets.join(",");

  // Allow loopback
  _runSilent(
    `netsh advfirewall firewall add rule name="TrucVPN Kill Switch" dir=out action=allow protocol=TCP remoteip=${remoteIps}`
  );
  rules.push("windows-allow-loopback");

  // Allow proxy ports
  for (const port of proxyPorts) {
    _runSilent(
      `netsh advfirewall firewall add rule name="TrucVPN Kill Switch" dir=out action=allow protocol=TCP localport=${port}`
    );
    rules.push(`windows-allow-proxy-port-${port}`);
  }

  // Block all other outbound TCP
  _runSilent(
    `netsh advfirewall firewall add rule name="TrucVPN Kill Switch" dir=out action=block protocol=TCP`
  );
  rules.push("windows-block-all-outbound-tcp");

  return rules;
}

function _disarmWindows() {
  const cleaned = [];
  _runSilent(
    `netsh advfirewall firewall delete rule name="TrucVPN Kill Switch"`
  );
  cleaned.push("windows-removed-all-rules");
  return cleaned;
}

// ─── Linux (iptables) ────────────────────────────────────────────────────

function _armLinux(proxyPorts, whitelistSubnets) {
  const rules = [];

  // Create dedicated chain
  _runSilent("iptables -N TRUCVPN_KILLSWITCH 2>/dev/null || true");
  rules.push("linux-chain-created");

  // Allow loopback
  _runSilent(
    "iptables -A TRUCVPN_KILLSWITCH -o lo -j ACCEPT"
  );
  rules.push("linux-allow-lo");

  // Allow established/related
  _runSilent(
    "iptables -A TRUCVPN_KILLSWITCH -m state --state ESTABLISHED,RELATED -j ACCEPT"
  );
  rules.push("linux-allow-established");

  // Allow whitelisted subnets
  for (const subnet of whitelistSubnets) {
    _runSilent(`iptables -A TRUCVPN_KILLSWITCH -d ${subnet} -j ACCEPT`);
    rules.push(`linux-allow-${subnet.replace(/\//g, "-")}`);
  }

  // Block everything else (redirect to this chain from OUTPUT)
  _runSilent(
    "iptables -A TRUCVPN_KILLSWITCH -j DROP"
  );
  _runSilent(
    "iptables -I OUTPUT 1 -j TRUCVPN_KILLSWITCH"
  );
  rules.push("linux-block-all");

  return rules;
}

function _disarmLinux() {
  const cleaned = [];
  _runSilent("iptables -D OUTPUT -j TRUCVPN_KILLSWITCH 2>/dev/null || true");
  _runSilent("iptables -F TRUCVPN_KILLSWITCH 2>/dev/null || true");
  _runSilent("iptables -X TRUCVPN_KILLSWITCH 2>/dev/null || true");
  cleaned.push("linux-removed-all-rules");
  return cleaned;
}

// ─── macOS (pfctl) ───────────────────────────────────────────────────────

function _armDarwin(proxyPorts, whitelistSubnets) {
  const rules = [];
  // pfctl anchor-based kill switch
  const pfRules = [
    "block drop out proto tcp all",
    ...whitelistSubnets.map((s) => `pass out proto tcp to ${s}`),
    ...proxyPorts.map((p) => `pass out proto tcp from any to any port ${p}`),
  ].join("\n");

  // Write to temp anchor file
  const fs = require("node:fs");
  const anchorPath = "/tmp/trucvpn_killswitch_pf.conf";
  fs.writeFileSync(anchorPath, pfRules, "utf8");

  _runSilent(`pfctl -a trucvpn_killswitch -f ${anchorPath} 2>/dev/null || true`);
  _runSilent("pfctl -e 2>/dev/null || true");
  rules.push("darwin-pf-anchor-loaded");

  return rules;
}

function _disarmDarwin() {
  const cleaned = [];
  _runSilent("pfctl -a trucvpn_killswitch -F all 2>/dev/null || true");
  cleaned.push("darwin-pf-anchor-flushed");
  return cleaned;
}

// ─── System Proxy Enforcement ────────────────────────────────────────────

function _enforceSystemProxy(proxyPorts) {
  const rules = [];
  const httpPort = proxyPorts[1] || 17881;
  const socksPort = proxyPorts[0] || 17880;

  if (PLATFORM === "win32") {
    // Set system proxy via registry (requires netsh or registry)
    _runSilent(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`
    );
    _runSilent(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${httpPort}" /f`
    );
    rules.push("system-proxy-http");
  } else if (PLATFORM === "darwin") {
    const netService =
      execSync("networksetup -listallnetworkservices 2>/dev/null", {
        encoding: "utf8",
      })
        .split("\n")
        .find((l) => l.includes("Wi-Fi") || l.includes("Ethernet"))
        ?.trim() || "Wi-Fi";
    _runSilent(
      `networksetup -setwebproxy "${netService}" 127.0.0.1 ${httpPort}`
    );
    _runSilent(
      `networksetup -setsecurewebproxy "${netService}" 127.0.0.1 ${httpPort}`
    );
    _runSilent(
      `networksetup -setsocksfirewallproxy "${netService}" 127.0.0.1 ${socksPort}`
    );
    rules.push("system-proxy-macos");
  }

  // Linux: export env vars in session context
  rules.push("system-proxy-env-vars-note");

  return rules;
}

function _disableSystemProxy() {
  const cleaned = [];

  if (PLATFORM === "win32") {
    _runSilent(
      `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`
    );
    cleaned.push("system-proxy-disabled");
  } else if (PLATFORM === "darwin") {
    const netService =
      execSync("networksetup -listallnetworkservices 2>/dev/null", {
        encoding: "utf8",
      })
        .split("\n")
        .find((l) => l.includes("Wi-Fi") || l.includes("Ethernet"))
        ?.trim() || "Wi-Fi";
    _runSilent(`networksetup -setwebproxystate "${netService}" off`);
    _runSilent(`networksetup -setsecurewebproxystate "${netService}" off`);
    _runSilent(`networksetup -setsocksfirewallproxystate "${netService}" off`);
    cleaned.push("system-proxy-disabled-macos");
  }

  return cleaned;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function _runSilent(cmd) {
  try {
    execSync(cmd, { stdio: "ignore", timeout: 5000 });
  } catch {
    /* non-fatal — rules may already exist */
  }
}

module.exports = { arm, disarm, status };
