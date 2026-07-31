/**
 * TUN path stub — design-only module.
 * Does NOT require Wintun/WireGuard drivers at compile or test time.
 * Full implementation tracked in docs/design-tun.md.
 */

export interface TunConfig {
  enabled: boolean;
  driver: 'wintun' | 'wireguard';
  interface: string;
  mtu: number;
  allowedIPs: string[];
  dns: string[];
}

export const DEFAULT_TUN_CONFIG: TunConfig = {
  enabled: false,
  driver: 'wintun',
  interface: 'trucvpn0',
  mtu: 1420,
  allowedIPs: ['0.0.0.0/0'],
  dns: ['1.1.1.1'],
};

export class TunStub {
  private config: TunConfig;
  private active = false;

  constructor(config: Partial<TunConfig> = {}) {
    this.config = { ...DEFAULT_TUN_CONFIG, ...config };
  }

  getConfig(): TunConfig {
    return { ...this.config };
  }

  isAvailable(): boolean {
    // Stub always returns false — drivers not loaded in test/CI
    return false;
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.active) {
      return { ok: false, error: 'TUN already active' };
    }
    if (!this.config.enabled) {
      return { ok: false, error: 'TUN not enabled in config' };
    }
    // Stub: never actually creates adapter
    return { ok: false, error: 'TUN driver not available (stub mode)' };
  }

  async stop(): Promise<{ ok: boolean }> {
    this.active = false;
    return { ok: true };
  }

  getStatus(): { active: boolean; available: boolean; config: TunConfig } {
    return {
      active: this.active,
      available: this.isAvailable(),
      config: this.getConfig(),
    };
  }
}
