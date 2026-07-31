# TrucVPN TUN Path Design

## Overview
Optional kernel-level TUN adapter path using Wintun (Windows) and WireGuard-compatible interfaces. SOCKS proxy remains the default; TUN is opt-in via configuration.

## Architecture

```
Application → TUN Interface → WireGuard Tunnel → Exit Node
                ↑ (optional)           ↑
           Wintun driver        UDP encapsulation
```

## Security Considerations
- TUN interface requires administrator/root privileges for creation
- WireGuard handshake uses Noise protocol (Curve25519 + ChaCha20Poly1305)
- Packets not matching the tunnel route are dropped (no leak)
- Kill-switch integration recommended when TUN is active

## Configuration
```json
{
  "tunnel": {
    "enabled": false,
    "driver": "wintun",
    "interface": "trucvpn0",
    "mtu": 1420,
    "allowedIPs": ["0.0.0.0/0"],
    "dns": ["1.1.1.1"]
  }
}
```

## Implementation Plan
1. **Phase 1**: Config schema + validation
2. **Phase 2**: Wintun DLL loading (Windows)
3. **Phase 3**: TUN adapter creation and route setup
4. **Phase 4**: Packet read/write loop with WireGuard encapsulation
5. **Phase 5**: Graceful shutdown and adapter cleanup

## Limitations
- Windows-only in initial implementation (Wintun)
- Requires admin privileges for adapter creation
- No kernel bypass mode (user-space TUN only)
- DNS configuration requires system-level changes
