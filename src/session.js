"use strict";

const { BandwidthMeter } = require("./meter");
const { createSocks5Server } = require("./proxy/socks5");
const { createHttpProxyServer } = require("./proxy/http");
const { loadConfig, saveSession, loadSession } = require("./config");
const { listExits, pickExit, findExit } = require("./catalog");
const killswitch = require("./killswitch");
const { buildChain } = require("./multihop");
const { LoadBalancer } = require("./balancer");

/** In-process active VPN session (one per CLI process). */
let active = null;

function getActive() {
  return active;
}

async function connect({ exitId, region, json, multiHopChain } = {}) {
  if (active) {
    throw new Error("already connected - disconnect first");
  }
  const config = loadConfig();
  const exits = await listExits(config);

  // Initialize load balancer for multi-user share distribution
  const balancer = new LoadBalancer({
    exits: exits.filter((e) => e.protocol !== "direct"),
    strategy: config.loadBalancerStrategy || "adaptive",
    maxPerExit: config.maxConnectionsPerExit || 100,
  });

  let exit;
  let effectiveExit;

  // Multi-hop chain support (#7)
  if (multiHopChain && multiHopChain.length > 0) {
    const chain = buildChain(exits, multiHopChain);
    if (chain.length === 0) {
      throw new Error("no valid exits in multi-hop chain");
    }
    effectiveExit = {
      id: `chain_${chain.map((e) => e.id).join("_")}`,
      name: `Chain: ${chain.map((e) => e.name || e.id).join(" → ")}`,
      protocol: "multi-hop",
      chain,
      region: chain[0].region,
      residential: chain.some((e) => e.residential !== false),
      source: "multi-hop-chain",
    };
  } else {
    // Use balancer to pick best exit (#16)
    exit = exitId
      ? findExit(exits, exitId)
      : balancer.pickExit({ preferredRegion: region || config.preferredRegion });
    if (!exit) {
      throw new Error("no exit selected");
    }

    // When share node is offline and exit points at share ports, fall back to direct
    effectiveExit = { ...exit };
    if (exit.protocol !== "direct") {
      const ok = await probeShare(exit);
      if (!ok) {
        effectiveExit = {
          id: `${exit.id}+direct-fallback`,
          name: `${exit.name} (direct fallback)`,
          protocol: "direct",
          region: exit.region,
          residential: false,
          source: "direct-fallback",
          parent_exit: exit.id,
        };
      }
    }
  }

  const meter = new BandwidthMeter();
  const logs = [];
  const onLog = (line) => {
    logs.push({ t: Date.now(), line: String(line) });
    if (logs.length > 200) {
      logs.shift();
    }
  };

  const getExit = () => effectiveExit;
  const socks = await createSocks5Server({
    host: config.localSocksHost,
    port: config.localSocksPort,
    getExit,
    meter,
    onLog
  });
  const httpProxy = await createHttpProxyServer({
    host: config.localHttpHost,
    port: config.localHttpPort,
    getExit,
    meter,
    onLog
  });

  const session = {
    id: `sess_${Date.now().toString(36)}`,
    connected_at: new Date().toISOString(),
    exit: effectiveExit,
    requested_exit: exit,
    socks: { host: config.localSocksHost, port: config.localSocksPort },
    http: { host: config.localHttpHost, port: config.localHttpPort },
    kill_switch: Boolean(config.killSwitch),
    kill_switch_armed: false,
    split_tunnel: config.splitTunnel || [],
    consumer_mrg_per_gb: config.consumerMrgPerGb,
    multi_hop: Boolean(multiHopChain && multiHopChain.length > 0),
    balancer,
    meter,
    logs,
    servers: { socks, http: httpProxy },
    status() {
      return {
        id: this.id,
        connected: true,
        connected_at: this.connected_at,
        exit: this.exit,
        requested_exit: this.requested_exit,
        socks: this.socks,
        http: this.http,
        kill_switch: this.kill_switch,
        kill_switch_armed: this.kill_switch_armed,
        split_tunnel: this.split_tunnel,
        multi_hop: this.multi_hop,
        balancer: balancer.snapshot(),
        traffic: this.meter.snapshot(this.consumer_mrg_per_gb),
        recent_logs: this.logs.slice(-10)
      };
    }
  };

  active = session;

  // Arm kill switch if configured (#4)
  if (config.killSwitch) {
    try {
      const ksResult = killswitch.arm({
        mode: config.killSwitchMode || "strict",
        proxyPorts: [config.localSocksPort, config.localHttpPort],
      });
      session.kill_switch_armed = true;
      onLog(`kill-switch armed (${ksResult.mode}): ${ksResult.rules.length} rules`);
    } catch (err) {
      onLog(`kill-switch arm failed: ${err.message}`);
    }
  }

  saveSession({
    id: session.id,
    connected_at: session.connected_at,
    exit: session.exit,
    socks: session.socks,
    http: session.http
  });

  if (!json) {
    console.log(`TrucVPN connected via ${effectiveExit.id} (${effectiveExit.protocol})`);
    console.log(`  SOCKS5  ${config.localSocksHost}:${config.localSocksPort}`);
    console.log(`  HTTP    ${config.localHttpHost}:${config.localHttpPort}`);
    if (effectiveExit.source === "direct-fallback") {
      console.log("  Note: MRGMinner share offline - using direct dial. Run: mrgminner share start");
    }
  }
  return session;
}

async function disconnect() {
  if (!active) {
    return { connected: false };
  }
  const snap = active.status();

  // Disarm kill switch if armed (#4)
  if (active.kill_switch_armed) {
    try {
      killswitch.disarm();
    } catch {
      /* ignore */
    }
  }

  try {
    active.servers.socks.close();
  } catch {
    /* ignore */
  }
  try {
    active.servers.http.close();
  } catch {
    /* ignore */
  }
  active = null;
  saveSession(null);
  return { connected: false, last: snap };
}

async function status() {
  if (active) {
    return active.status();
  }
  const disk = loadSession();
  return {
    connected: false,
    session_file: disk,
    hint: "run: trucvpn connect"
  };
}

async function probeShare(exit) {
  if (!exit || !exit.host || !exit.port) {
    return false;
  }
  // Try share HTTP control plane first
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`http://${exit.host}:${exit.port}/v1/health`, {
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(t);
    if (res && res.ok) {
      return true;
    }
  } catch {
    /* fall through */
  }
  // TCP open on port is enough for raw socks share
  return await tcpOpen(exit.host, Number(exit.port), 600);
}

function tcpOpen(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require("node:net");
    const socket = net.connect({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

module.exports = {
  getActive,
  connect,
  disconnect,
  status,
  listExits
};
