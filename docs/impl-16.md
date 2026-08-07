# Implementation #16 — Multi-User Share Load Balancer Across Exits

**Issue**: [#16](https://github.com/mergeos-bounties/TrucVPN/issues/16)  
**Bounty**: 200 MRG  
**Feature**: Multi-user share load balancer across exits

## Summary

TrucVPN share nodes (MRGMinner) expose residential exit capacity to multiple concurrent users.  
This implementation adds a **load balancer** (`src/load-balancer.js`) that distributes user sessions across available exits using pluggable strategies.

## Architecture

```
User 1 ──┐                         ┌── Exit VN (socks5)
User 2 ──┤    Load Balancer         ├── Exit US (http-connect)
User N ──┘   (MultiUserLoadBalancer)├── Exit SG (socks5)
                   │                └── Exit EU (direct fallback)
                   │
              Share Server (MRGMinner)
```

### Core Module: `src/load-balancer.js`

Exports:

| Export | Description |
|--------|-------------|
| `MultiUserLoadBalancer` | Class managing exit assignment across concurrent users |
| `createLoadBalancer(config)` | Factory function for creating configured balancer instances |

### Load Balancing Strategies

| Strategy | Behavior |
|----------|----------|
| `round-robin` (default) | Cycles through available exits in order, distributing users evenly |
| `least-loaded` | Assigns each new user to the exit with the lowest current `load` metric |
| `weighted-latency` | Weights exits by inverse latency; lower-latency exits get more users |
| `region-affinity` | Routes users to exits in their preferred region when available; falls back to round-robin |

### Key Design Decisions

1. **Session-to-Exit binding** — Once a user is assigned to an exit, their session stays bound to that exit until disconnect (sticky sessions). This avoids mid-session exit switches that could break TCP connections.

2. **Exit health tracking** — The balancer periodically probes exits via `/v1/health` on the share control plane. Unhealthy exits are temporarily removed from the rotation and re-checked after a 30-second cooldown.

3. **Fallback chain** — If no residential exit is available (all share nodes offline), users fall back to `direct` (local proxy only). The fallback is transparent to the client.

4. **Multi-user isolation** — Each user session tracks its own `bytes_in`, `bytes_out`, and `estimated_mrg_cost` independently via the existing `BandwidthMeter`.

### Integration Points

- **`src/catalog.js`** — `pickExit()` enhanced to accept an optional `strategy` parameter; the existing `load` field on exits is used by `least-loaded` strategy.
- **`src/session.js`** — `connect()` can now receive a `balancer` instance; if provided, exit selection is delegated to the balancer instead of a single `pickExit()` call.
- **`src/proxy/upstream.js`** — No changes; the balancer operates at the exit selection layer, not the transport layer.
- **`src/config.js`** — New optional config keys: `lbStrategy` (string), `lbStickySessions` (boolean).

### Configuration Example

```json
{
  "lbStrategy": "round-robin",
  "lbStickySessions": true,
  "shareDiscoveryUrl": "http://127.0.0.1:17890"
}
```

## Testing

### Unit Tests: `tests/load-balancer.test.js`

Covers:
- Round-robin distribution correctness across N users and M exits
- Least-loaded strategy preferring low-load exits
- Exit health check timeout handling
- Sticky session persistence (same user gets same exit on re-assign)
- Fallback to direct when all residential exits are unhealthy
- Strategy selection from config

### CI Pipeline: `.github/workflows/ci-16.yml`

Runs on every push to `feat/impl-16-*` branches and PRs touching relevant paths:

| Job | Node Versions | What it Tests |
|-----|--------------|---------------|
| `unit-tests` | 18.x, 20.x, 22.x | `tests/load-balancer.test.js`, `tests/catalog.test.js`, `tests/meter.test.js` |
| `load-balancer-smoke` | 20.x | Real `MultiUserLoadBalancer` instantiation, round-robin + least-loaded strategies |
| `lint` | 20.x | Syntax check on all modified source files |

## API Reference

### `new MultiUserLoadBalancer({ exits, strategy, stickySessions, healthCheckIntervalMs })`

- `exits` — Array of exit objects `{ id, region, load, latency_ms, protocol, host, port }`
- `strategy` — `'round-robin'` | `'least-loaded'` | `'weighted-latency'` | `'region-affinity'` (default: `'round-robin'`)
- `stickySessions` — Keep user→exit binding across reconnects (default: `true`)
- `healthCheckIntervalMs` — How often to re-probe unhealthy exits (default: `30000`)

### `balancer.assignExitForUser(userId, preferredRegion?)`

Returns `{ exit, isFallback, assignedAt }`. If no healthy exit is available, returns a `direct` fallback exit.

### `balancer.releaseUser(userId)`

Frees the user's slot so another user can be assigned to that exit.

### `balancer.getStats()`

Returns `{ totalUsers, exitsInRotation, unhealthyExits, strategy }` for dashboard/metrics.

## Evidence

- CI workflow `.github/workflows/ci-16.yml` runs multi-strategy smoke tests
- CLI demo shows round-robin distribution across 3 mock exits with 10 concurrent users
- Dashboard `GET /v1/lb/stats` endpoint exposes balancer state

## DCO

Signed-off-by: laurentketterle-hub <noreply@users.noreply.github.com>
