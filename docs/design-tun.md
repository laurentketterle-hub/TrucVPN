# Design: Optional Wintun/WireGuard Kernel TUN Path

## Status
**Research / Stub** — not integrated into the default data path.
SOCKS5 remains the default; TUN is opt-in behind a feature flag.

## Motivation
SOCKS5 works per-app but cannot capture all system traffic (UDP, ICMP,
non-proxy-aware apps). A kernel TUN adapter (Wintun on Windows,
WireGuard's cross-platform TUN) would allow **full-device VPN** with
split-tunnel policies, complementary to the existing SOCKS path.

## Architecture

```
 Apps ──► TUN iface (Wintun) ──► tun-router ──► exit-selector ──► Exit Node
                                                     │
 SOCKS-aware apps ──► SOCKS5 proxy ──────────────────┘
```

Both paths share the same `exit-selector` and `meter`.

## Components

| Layer            | File (planned)        | Notes                         |
|------------------|-----------------------|-------------------------------|
| TUN stub         | `src/tun/wintun.ts`   | No-op stub; no native deps    |
| TUN adapter      | `src/tun/adapter.ts`  | Wintun FFI / WireGuard-go IPC |
| Router           | `src/tun/router.ts`   | IP packet → exit              |
| Config validator | `src/tun/config.ts`   | Feature-flag gate             |

## Wintun Integration (Windows)

- Use the **Wintun DLL** (LGPL, from WireGuard project)
- Node.js FFI via `ffi-napi` or `koffi` (no native build in CI)
- Create adapter, set IP, read/write packets via ring buffers

## WireGuard Path (cross-platform)

- Embed `wireguard-go` as a sidecar process
- IPC over a local Unix socket / named pipe
- TUN fd passed to Node via `node-ffi`; packets proxied to exit

## Feature Gate

```ts
// config.ts or env
TUN_ENABLED = false   // default off — SOCKS path only
// Set TUN_ENABLED=true + TUN_DEVICE_GUID=... to activate
```

## CI Strategy

- Stub module compiles with zero native dependencies
- CI workflow (`ci-8.yml`) runs `tsc --noEmit` on `src/tun/`
- No driver installation, no admin rights required
- Integration tests gated behind `TUN_ENABLED=true` on real Windows

## Next Steps

1. [ ] Spike: Wintun FFI with koffi — create/destroy adapter
2. [ ] Spike: IP packet parse + NAT in pure TypeScript
3. [ ] Integrate with `exit-selector` from SOCKS path
4. [ ] Add `tun` CLI subcommand (`trucvpn tun up/down`)
5. [ ] Split-tunnel policy: route by CIDR or process name

## References

- [Wintun](https://www.wintun.net/) — TUN driver for Windows
- [WireGuard](https://www.wireguard.com/) — cross-platform VPN
- [koffi](https://koffi.dev/) — Node FFI without node-gyp
