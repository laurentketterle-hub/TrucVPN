"use strict";

const { loadConfig, saveConfig } = require("./config");
const { listExits, pickExit, findExit, sampleExits, summarizeRegions } = require("./catalog");
const session = require("./session");
const { startControlDaemon } = require("./dashboard");
const { formatBytes } = require("./meter");
const { buildPlan, executePlan } = require("./firewall");
const pkg = require("../package.json");

async function main(argv) {
  const [command = "help", ...rest] = argv;
  const flags = parseFlags(rest);
  switch (command) {
    case "version":
      console.log(JSON.stringify({ name: "trucvpn", version: pkg.version }, null, 2));
      return;
    case "help":
    case "--help":
    case "-h":
      return help();
    case "configure":
      return configure(flags);
    case "list":
    case "exits":
      return listCommand(flags);
    case "regions":
      return regionsCommand(flags);
    case "connect":
      return connectCommand(flags);
    case "disconnect":
      return disconnectCommand(flags);
    case "status":
      return statusCommand(flags);
    case "demo":
      return demoCommand(flags);
    case "daemon":
    case "serve":
    case "dashboard":
    case "gui":
      return daemonCommand(flags);
    case "doctor":
      return doctorCommand(flags);
    case "kill-switch":
      return killSwitchCommand(flags);
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function help() {
  console.log(`TrucVPN ${pkg.version} - residential VPN client (MRGMinner share exits)

Usage:
  trucvpn version
  trucvpn configure [--kill-switch true|false] [--socks-port N] [--http-port N] [--dashboard-host HOST] [--dashboard-port N] [--share-url URL] [--region CODE]
  trucvpn list [--json]
  trucvpn regions [--json]
  trucvpn connect [--exit ID] [--region CODE] [--allow-direct] [--json]
  trucvpn disconnect [--json]
  trucvpn status [--json]
  trucvpn doctor
  trucvpn demo [--keep] [--allow-direct]
  trucvpn kill-switch [--exit ID] [--platform win32|linux|darwin] [--apply] [--revert] [--allow-lan] [--allow-dns]
  trucvpn daemon [--host HOST] [--port N]

Architecture:
  Native apps/extensions -> TrucVPN control daemon -> local SOCKS5/HTTP -> MRGMinner share exit -> Internet
  Sharers earn MRG for bandwidth via: mrgminner share start

Kill Switch:
  When enabled, TrucVPN refuses to route traffic without a tunneled exit.
  Enable:  trucvpn configure --kill-switch true
  Disable: trucvpn configure --kill-switch false
  Override for one run: trucvpn connect --allow-direct
  OS firewall rules: trucvpn kill-switch --apply

MergeOS: https://github.com/mergeos-bounties - Token: MRG
`);
}

function configure(flags) {
  const updates = {};
  if (flags["socks-port"]) {
    updates.localSocksPort = Number(flags["socks-port"]);
  }
  if (flags["http-port"]) {
    updates.localHttpPort = Number(flags["http-port"]);
  }
  if (flags["dashboard-host"]) {
    updates.dashboardHost = String(flags["dashboard-host"]);
  }
  if (flags["dashboard-port"]) {
    updates.dashboardPort = Number(flags["dashboard-port"]);
  }
  if (flags["share-url"]) {
    updates.shareDiscoveryUrl = String(flags["share-url"]);
  }
  if (flags.region) {
    updates.preferredRegion = String(flags.region);
  }
  if (flags["kill-switch"] === true || flags["kill-switch"] === "true") {
    updates.killSwitch = true;
  }
  if (flags["kill-switch"] === "false") {
    updates.killSwitch = false;
  }
  const cfg = saveConfig(updates);
  console.log(JSON.stringify({ ok: true, config: redact(cfg) }, null, 2));
}

async function regionsCommand(flags) {
  const cfg = loadConfig();
  const exits = await listExits(cfg);
  const regions = summarizeRegions(exits);
  if (flags.json) {
    console.log(JSON.stringify({ regions }, null, 2));
    return;
  }
  console.log(`Regions (${regions.length})  exits=${exits.length}`);
  for (const region of regions) {
    console.log(
      `  ${region.region.padEnd(8)}  ${String(region.exits).padStart(3)} exits  ${String(region.residential).padStart(3)} residential`
    );
  }
}

async function listCommand(flags) {
  const cfg = loadConfig();
  const exits = await listExits(cfg);
  if (flags.json) {
    console.log(JSON.stringify({ exits }, null, 2));
    return;
  }
  console.log(`Exits (${exits.length})  share=${cfg.shareDiscoveryUrl}`);
  for (const e of exits) {
    const res = e.residential ? "residential" : "local";
    console.log(
      `  ${e.id.padEnd(18)}  ${String(e.region || "-").padEnd(6)}  ${String(e.protocol).padEnd(12)}  ${res}  ${e.latency_ms ?? "?"}ms  ${e.name || ""}`
    );
  }
}

async function connectCommand(flags) {
  const s = await session.connect({
    exitId: flags.exit || flags.e,
    region: flags.region,
    json: Boolean(flags.json),
    allowDirect: Boolean(flags["allow-direct"])
  });
  if (flags.json) {
    console.log(JSON.stringify(s.status(), null, 2));
  }
}

async function disconnectCommand(flags) {
  const r = await session.disconnect();
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log("TrucVPN disconnected");
    if (r.last && r.last.traffic) {
      console.log(`  traffic ${formatBytes(r.last.traffic.bytes_total)}  est_mrg ${r.last.traffic.estimated_mrg_cost}`);
    }
  }
}

async function statusCommand(flags) {
  const s = await session.status();
  if (flags.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (!s.connected) {
    console.log("status: disconnected");
    if (s.hint) {
      console.log(`  ${s.hint}`);
    }
    return;
  }
  console.log("status: connected");
  console.log(`  exit   ${s.exit.id} (${s.exit.protocol})`);
  console.log(`  socks  ${s.socks.host}:${s.socks.port}`);
  console.log(`  http   ${s.http.host}:${s.http.port}`);
  console.log(`  kill-switch  ${s.kill_switch ? "armed" : "off"}`);
  if (s.kill_switch_overridden) {
    console.log(`  kill-switch  overridden (--allow-direct used)`);
  }
  console.log(
    `  traffic in=${formatBytes(s.traffic.bytes_in)} out=${formatBytes(s.traffic.bytes_out)} mrg~${s.traffic.estimated_mrg_cost}`
  );
}

async function doctorCommand() {
  const cfg = loadConfig();
  const sample = sampleExits();
  const live = await listExits(cfg);
  const report = {
    version: pkg.version,
    config: redact(cfg),
    sample_exits: sample.length,
    listed_exits: live.length,
    residential: live.filter((e) => e.residential).length,
    share_url: cfg.shareDiscoveryUrl,
    ok: true
  };
  console.log(JSON.stringify(report, null, 2));
}

async function demoCommand(flags) {
  const cfg = loadConfig();
  const exits = await listExits(cfg);
  const pick = pickExit(exits, "local") || exits[0];
  const direct = findExit(exits, "direct-local") || pick;
  console.log("TrucVPN demo");
  console.log(`  catalog exits: ${exits.length}`);
  console.log(`  connecting via ${direct.id} ...`);
  const s = await session.connect({
    exitId: direct.id,
    json: true,
    allowDirect: Boolean(flags["allow-direct"])
  });
  const st = s.status();
  console.log(`  SOCKS5 ${st.socks.host}:${st.socks.port}`);
  console.log(`  HTTP   ${st.http.host}:${st.http.port}`);
  if (!flags.keep) {
    await session.disconnect();
    console.log("  demo complete (disconnected). For live share: mrgminner share start && trucvpn connect");
  } else {
    console.log("  keeping session (--keep). Ctrl+C to stop after daemon if needed.");
  }
}

async function daemonCommand(flags) {
  const host = flags.host ? String(flags.host) : undefined;
  const port = flags.port ? Number(flags.port) : undefined;
  const { url } = await startControlDaemon({ host, port });
  console.log(`TrucVPN control daemon: ${url}`);
  console.log("Native apps and browser extensions use this local API.");
  console.log("Press Ctrl+C to stop.");
  await new Promise(() => {});
}

async function killSwitchCommand(flags) {
  const cfg = loadConfig();
  const apply = Boolean(flags.apply);
  const revert = Boolean(flags.revert);

  const exitId = flags.exit || flags.e;
  const exits = [];
  if (exitId) {
    const all = await listExits(cfg);
    const found = findExit(all, exitId);
    if (found) exits.push(found);
  }

  const plan = buildPlan({
    exits,
    allowLan: Boolean(flags["allow-lan"]),
    allowDns: Boolean(flags["allow-dns"]),
    platform: flags.platform
  });

  if (apply || revert) {
    const result = executePlan(plan, { apply, revert });
    if (result.ok) {
      console.log(JSON.stringify({ ok: true, action: revert ? "revert" : "apply", count: result.results.length }, null, 2));
    } else {
      console.error(JSON.stringify({ ok: false, error: result.error }, null, 2));
      process.exitCode = 1;
    }
  } else {
    console.log(`Kill-switch firewall plan (${plan.platform})${plan.complete ? "" : " -- INCOMPLETE (unresolvable hosts)"}`);
    console.log(`Enabled: killSwitch=${cfg.killSwitch}`);
    console.log(`Rule name: ${plan.ruleName || plan.tableName || plan.anchorName || "(default)"}`);
    if (plan.error) {
      console.log(`Error: ${plan.error}`);
    }
    console.log("
-- Apply --");
    for (const c of plan.commands) {
      console.log(`  ${c}`);
    }
    console.log("
-- Revert --");
    for (const c of plan.revert) {
      console.log(`  ${c}`);
    }
    if (!plan.complete) {
      console.log("
WARNING: Plan is incomplete. --apply will refuse. Fix exit resolution first.");
    }
    console.log("
Use --apply to execute, --revert to remove rules.");
  }
}

function redact(cfg) {
  return { ...cfg };
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (!flags._) {
        flags._ = [];
      }
      flags._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

module.exports = { main };
