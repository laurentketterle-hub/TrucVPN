/**
 * Wintun/WireGuard TUN stub — opt-in kernel networking path.
 *
 * COMPILE-TIME ONLY. No native dependencies. No drivers required in CI.
 * Set TUN_ENABLED=true at runtime on a real Windows host to activate.
 *
 * @module src/tun/wintun
 */

export interface TunConfig {
  /** Wintun adapter GUID (Windows) or ifname (Linux) */
  deviceId: string;
  /** IPv4 address assigned to the TUN interface, e.g. "10.99.0.2/24" */
  address: string;
  /** MTU (default 1420 for WireGuard) */
  mtu: number;
  /** DNS server pushed to the interface */
  dns?: string;
}

export interface TunAdapter {
  readonly config: TunConfig;
  readonly isUp: boolean;
  /** Open the TUN device (requires admin on Windows) */
  up(): Promise<void>;
  /** Close the TUN device */
  down(): Promise<void>;
  /** Read next IP packet (returns null when nothing queued) */
  read(): Promise<Buffer | null>;
  /** Write an IP packet into the TUN device */
  write(packet: Buffer): Promise<void>;
}

/**
 * Stub factory — returns a no-op adapter when TUN is disabled or
 * the platform does not support Wintun/WireGuard.
 */
export function createTunAdapter(config: TunConfig): TunAdapter {
  return {
    config,
    isUp: false,
    async up(): Promise<void> {
      if (!process.env.TUN_ENABLED) {
        throw new Error(
          'TUN_ENABLED is not set. TUN path is opt-in. ' +
          'Set TUN_ENABLED=true to enable kernel networking.'
        );
      }
      // TODO: Wintun FFI — koffi load("wintun.dll"), WintunCreateAdapter, etc.
      throw new Error('Wintun FFI not yet implemented (stub).');
    },
    async down(): Promise<void> {
      // no-op in stub — real impl would call WintunCloseAdapter
    },
    async read(): Promise<Buffer | null> {
      return null; // no packets in stub
    },
    async write(_packet: Buffer): Promise<void> {
      // no-op in stub — real impl would write to Wintun ring buffer
    },
  };
}

/** Quick capability check — always false in stub. */
export function isTunSupported(): boolean {
  return false;
}
