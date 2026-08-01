"use strict";

/**
 * Wintun/WireGuard TUN Path — design document + stub implementation.
 * Implements #8 [200 MRG] Research: optional Wintun/WireGuard path design + stub.
 *
 * This module provides:
 *   1. Architecture design for TUN-level VPN integration
 *   2. Platform-specific TUN adapter stubs (Wintun on Windows, utun on macOS, /dev/net/tun on Linux)
 *   3. WireGuard configuration generator
 *   4. Health check integration with the main daemon
 *
 * NOTE: Full WireGuard integration requires:
 *   - WireGuard NT kernel driver (Windows) or wireguard-go (cross-platform)
 *   - Wintun.dll (Windows TUN adapter)
 *   - Root/Administrator privileges for TUN device creation
 *
 * This stub provides the DESIGN, not the kernel-level implementation.
 * It validates that the TUN path is correctly architected and wired into
 * the TrucVPN daemon lifecycle.
 */

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { statePath, ensureStateDir } = require("./config");

const PLATFORM = os.platform();

// ─── Design Document ─────────────────────────────────────────────────────

/**
 * TrucVPN TUN Path Architecture
 * =============================
 *
 * Layer stack (bottom-up):
 *
 *   ┌─────────────────────────────────────────────┐
 *   │  TrucVPN Daemon (dashboard.js)              │
 *   │  ┌─────────────┐  ┌──────────────────────┐  │
 *   │  │ SOCKS5/HTTP │  │ TUN Controller       │  │
 *   │  │ Proxy Path  │  │ (tun.js)             │  │
 *   │  └──────┬──────┘  └──────────┬───────────┘  │
 *   │         │                    │               │
 *   │  ┌──────▼────────────────────▼───────────┐  │
 *   │  │         Exit Router                   │  │
 *   │  │  (multi-hop, balancer, kill-switch)   │  │
 *   │  └──────────────────┬───────────────────┘  │
 *   └─────────────────────┼──────────────────────┘
 *                         │
 *   ┌─────────────────────▼──────────────────────┐
 *   │           TUN Adapter (L3)                  │
 *   │  ┌──────────────┐  ┌────────────────────┐  │
 *   │  │ Wintun (Win) │  │ utun (macOS)       │  │
 *   │  │ wireguard-go │  │ /dev/net/tun (Lin) │  │
 *   │  └──────────────┘  └────────────────────┘  │
 *   └─────────────────────┬──────────────────────┘
 *                         │
 *   ┌─────────────────────▼──────────────────────┐
 *   │  WireGuard / Raw IP Tunnel (kernel)         │
 *   │  - wg0 interface                            │
 *   │  - Encrypted UDP transport                  │
 *   │  - Route all traffic (0.0.0.0/0 → wg0)     │
 *   └────────────────────────────────────────────┘
 *
 * Benefits over SOCKS5/HTTP proxy path:
 *   - System-wide VPN (all apps, not just proxy-aware)
 *   - UDP support (DNS, QUIC, WebRTC)
 *   - Lower overhead (no TCP-in-TCP meltdown)
 *   - Seamless roaming (WireGuard handles IP changes)
 *
 * Integration points:
 *   1. trucvpn connect --tun → arms TUN instead of proxy
 *   2. Dashboard /api/tun/status → shows TUN health
 *   3. Kill switch integration (firewall rules are TUN-aware)
 *   4. MRG metering at TUN level (packet counters)
 */

// ─── TUN Adapter Stubs ───────────────────────────────────────────────────

/**
 * Check if the host supports TUN mode.
 *
 * @returns {{ supported: boolean, reason?: string, platform: string }}
 */
function checkTunSupport() {
  if (PLATFORM === "win32") {
    // Wintun requires the wintun.dll in system32 or app directory
    const wintunPaths = [
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wintun.dll"),
      path.join(__dirname, "..", "bin", "wintun.dll"),
    ];
    const hasWintun = wintunPaths.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    return {
      supported: hasWintun,
      platform: "win32",
      reason: hasWintun ? undefined : "wintun.dll not found — install from wireguard.com",
      driverPaths: wintunPaths,
    };
  }

  if (PLATFORM === "linux") {
    const hasTun = _checkFile("/dev/net/tun");
    const hasWireguard = _checkModule("wireguard");
    return {
      supported: hasTun,
      platform: "linux",
      reason: hasTun ? undefined : "/dev/net/tun not available — run: modprobe tun",
      hasWireguardModule: hasWireguard,
    };
  }

  if (PLATFORM === "darwin") {
    // macOS uses utun (available since 10.6.8)
    const utunDevices = _listUtunDevices();
    return {
      supported: true,
      platform: "darwin",
      utunDevices,
    };
  }

  return {
    supported: false,
    platform: PLATFORM,
    reason: `unsupported platform: ${PLATFORM}`,
  };
}

/**
 * Generate a WireGuard configuration for a given exit.
 * This is a STUB — real WireGuard key exchange requires server-side support.
 *
 * @param {{ exitId: string, exitHost?: string, exitPort?: number }} opts
 * @returns {{ config: string, interface: object, peer: object }}
 */
function generateWireGuardConfig(opts = {}) {
  const exitId = opts.exitId || "trucvpn-exit";
  const exitHost = opts.exitHost || "127.0.0.1";
  const exitPort = opts.exitPort || 51820;

  // Stub keys (real implementation would generate via crypto)
  const privateKey = _stubKey("private");
  const publicKey = _stubKey("public");
  const peerPublicKey = _stubKey("peer-public");
  const presharedKey = _stubKey("preshared");

  const iface = {
    privateKey,
    address: ["10.200.0.2/24"],
    dns: ["1.1.1.1", "8.8.8.8"],
    mtu: 1420,
  };

  const peer = {
    publicKey: peerPublicKey,
    presharedKey,
    endpoint: `${exitHost}:${exitPort}`,
    allowedIps: ["0.0.0.0/0", "::/0"],
    persistentKeepalive: 25,
  };

  const config = `[Interface]
PrivateKey = ${privateKey}
Address = ${iface.address.join(", ")}
DNS = ${iface.dns.join(", ")}
MTU = ${iface.mtu}

[Peer]
PublicKey = ${peerPublicKey}
PresharedKey = ${presharedKey}
Endpoint = ${exitHost}:${exitPort}
AllowedIPs = ${peer.allowedIps.join(", ")}
PersistentKeepalive = ${peer.persistentKeepalive}
`;

  return { config, interface: iface, peer };
}

/**
 * Initialize TUN mode — bring up the TUN adapter and route traffic.
 * STUB: logs what WOULD happen. Real impl needs wireguard-go or kernel WireGuard.
 *
 * @param {{ exitId: string, exitHost?: string, exitPort?: number }} opts
 * @returns {Promise<{ initialized: true, tunInterface: string, routingTable: object }>}
 */
async function initializeTun(opts = {}) {
  const support = checkTunSupport();
  if (!support.supported) {
    throw new Error(`TUN mode not supported: ${support.reason}`);
  }

  const wgConfig = generateWireGuardConfig(opts);
  const tunName = PLATFORM === "win32" ? "Wintun" : PLATFORM === "darwin" ? "utun0" : "tun0";

  // Write WireGuard config stub to state dir
  ensureStateDir();
  const configPath = statePath("wireguard.conf");
  fs.writeFileSync(configPath, wgConfig.config, "utf8");

  // STUB: In production, this would call:
  //   wireguard-go -f ${tunName}
  //   wg setconf ${tunName} ${configPath}
  //   ip link set up ${tunName}
  //   ip route add default dev ${tunName} table trucvpn
  //   ip rule add from all table trucvpn

  const routingTable = {
    defaultRoute: `dev ${tunName} table trucvpn`,
    policyRule: "from all lookup trucvpn",
    stubNote: "wireguard-go or kernel WireGuard needed for production use",
  };

  return {
    initialized: true,
    tunInterface: tunName,
    configPath,
    routingTable,
  };
}

/**
 * Shutdown TUN mode — tear down the TUN adapter and restore routes.
 *
 * @returns {Promise<{ shutdown: true }>}
 */
async function shutdownTun() {
  // STUB: In production, this would:
  //   ip route del default table trucvpn
  //   ip rule del from all table trucvpn
  //   ip link set down ${tunName}
  //   kill wireguard-go process

  const configPath = statePath("wireguard.conf");
  try {
    fs.unlinkSync(configPath);
  } catch {
    /* already cleaned */
  }

  return { shutdown: true };
}

/**
 * Get TUN status for dashboard.
 *
 * @returns {{ active: boolean, tunInterface: string|null, configExists: boolean }}
 */
function tunStatus() {
  const configPath = statePath("wireguard.conf");
  const configExists = (() => {
    try {
      return fs.existsSync(configPath);
    } catch {
      return false;
    }
  })();

  const support = checkTunSupport();

  return {
    active: configExists,
    supported: support.supported,
    platform: support.platform,
    tunInterface: PLATFORM === "win32" ? "Wintun" : PLATFORM === "darwin" ? "utun" : "tun0",
    configExists,
    reason: support.reason || "ready",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function _checkFile(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function _checkModule(name) {
  try {
    const out = require("node:child_process").execSync(`lsmod | grep ${name} 2>/dev/null`, {
      encoding: "utf8",
      timeout: 2000,
    });
    return out.includes(name);
  } catch {
    return false;
  }
}

function _listUtunDevices() {
  try {
    const { execSync } = require("node:child_process");
    const out = execSync("ifconfig -l 2>/dev/null || ifconfig 2>/dev/null", {
      encoding: "utf8",
      timeout: 2000,
    });
    const matches = out.match(/utun\d+/g);
    return matches || [];
  } catch {
    return [];
  }
}

function _stubKey(type) {
  // Deterministic stub keys for design validation
  const base = "trucvpn-tun-stub-key-material-" + type;
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update(base).digest("base64").substring(0, 44);
}

module.exports = {
  checkTunSupport,
  generateWireGuardConfig,
  initializeTun,
  shutdownTun,
  tunStatus,
};
