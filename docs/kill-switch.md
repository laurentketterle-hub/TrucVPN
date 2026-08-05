# Kill Switch

TrucVPN's kill-switch prevents traffic leaks when the VPN tunnel is unavailable.
When enabled, connections that would bypass the residential exit are blocked.

## Quick Start

```bash
# Enable the kill switch (persists across sessions)
trucvpn configure --kill-switch true

# Connect normally — traffic is protected. If the share node is down, connect
# will refuse rather than falling back to a direct (unprotected) dial.
trucvpn connect --exit mock-vn-hcm

# One-time override (useful for testing or when you know what you're doing)
trucvpn connect --exit mock-vn-hcm --allow-direct

# Check status
trucvpn status
```

## How It Works

The kill switch operates at two layers:

### 1. Proxy Guard (in-process, no privileges required)

- **At connect time**: if the kill switch is enabled and the selected exit falls back
  to a direct dial (share node unreachable), `connect()` throws `KILL_SWITCH` and
  refuses to open any listeners. No proxy port is ever bound.
- **Per request**: if the exit turns direct mid-session, each SOCKS5 connection
  receives reply code `0x02` (*connection not allowed by ruleset*) and HTTP
  connections receive `403 Forbidden`. The target is never dialed.
- **Blocked connections** are counted in `status`.

### 2. OS Firewall Rules (CLI-only, requires admin/sudo)

The `trucvpn kill-switch` command builds firewall rules that block *all* outbound
traffic except loopback, the exit(s), and share discovery. Rules are **print-only
by default** — nothing changes until you pass `--apply`.

```bash
# Preview the rules for your platform
trucvpn kill-switch --exit mock-vn-hcm

# Apply them
trucvpn kill-switch --exit mock-vn-hcm --apply

# Remove them
trucvpn kill-switch --revert
```

Supported platforms:
- **Windows**: `netsh advfirewall` rules under a single named group
- **Linux**: `nftables` table (`trucvpn_ks`) — revert is one `nft delete table`
- **macOS**: `pf` anchor

## Limitations

### What the proxy guard CANNOT see

The proxy guard only covers traffic that passes through the local SOCKS5/HTTP
proxies. The following traffic bypasses it entirely:

| Traffic type | Reason |
|---|---|
| QUIC / HTTP/3 | Uses UDP, not routed through SOCKS5/HTTP |
| DNS (UDP/TCP port 53) | System resolver usually bypasses proxy |
| WebRTC | Peer-to-peer UDP, not proxy-aware |
| Other processes | Apps not configured to use the proxy |
| Other users / containers | Different network namespaces |
| OS telemetry / updates | System services ignore proxy settings |
| ICMP (ping) | Neither TCP nor UDP, never proxied |
| Window before TrucVPN starts | Brief interval between boot and TrucVPN launch |

### What the firewall rules can and cannot do

| Scenario | Coverage |
|---|---|
| All TCP from the machine | ✓ Blocked (except allowed exits) |
| All UDP from the machine | ✓ Blocked (except DNS if `--allow-dns`) |
| DNS leaks | Blocked by default; pass `--allow-dns` to opt into the leak |
| LAN access | Blocked by default; pass `--allow-lan` to opt in |
| Exit host resolution fails | `--apply` refuses (would block the exit too) |
| Rules outlive the TrucVPN process | ✓ Yes — they survive crashes and restarts |
| Remote SSH sessions | **Will drop your session** if applied on a remote box |

### Important Caveats

1. **Rules outlive the process.** If TrucVPN crashes or you forget to `--revert`,
   the firewall rules remain. Revert them from any shell:
   ```bash
   trucvpn kill-switch --revert
   ```

2. **DNS is blocked on purpose.** Without `--allow-dns`, even the system resolver
   cannot reach DNS servers. The exit hostname must already be resolved (or use
   an IP) for `--apply` to succeed.

3. **Incomplete plans are refused.** If an exit hostname cannot be resolved, the
   plan is marked incomplete and `--apply` refuses. A rule set that blocks the
   exit itself is worse than no rule set. `--revert` still works on incomplete
   plans so you can unblock a machine.

4. **Split tunneling is not yet integrated.** The `splitTunnel` config exists in
   the codebase but is not wired to the kill switch. This is tracked separately.

5. **Mid-session exit failover is not yet implemented.** If the exit goes
   unreachable mid-session, the proxy guard blocks traffic but cannot
   automatically switch to another exit (#7).

## Default

The kill switch is **off by default**. Enable it with:

```bash
trucvpn configure --kill-switch true
```

Disable with:

```bash
trucvpn configure --kill-switch false
```

## Testing

```bash
# Unit tests
npm test

# Manual verification (requires mrgminner)
# 1. Stop the share node
# 2. Enable kill switch
# 3. Try to connect — should be refused
trucvpn configure --kill-switch true && trucvpn connect --exit mock-vn-hcm
# Expected: "kill switch: ... refusing to leave without the exit"

# 4. Override for one run
trucvpn connect --exit mock-vn-hcm --allow-direct
# Expected: Connects with warning about overridden kill switch
```
