import { TunStub, DEFAULT_TUN_CONFIG } from '../../src/tun/stub';

describe('TunStub', () => {
  let tun: TunStub;

  beforeEach(() => {
    tun = new TunStub();
  });

  test('default config has TUN disabled', () => {
    expect(tun.getConfig().enabled).toBe(false);
  });

  test('accepts custom config', () => {
    const custom = new TunStub({ enabled: true, mtu: 1500 });
    expect(custom.getConfig().enabled).toBe(true);
    expect(custom.getConfig().mtu).toBe(1500);
  });

  test('isAvailable returns false in stub mode', () => {
    expect(tun.isAvailable()).toBe(false);
  });

  test('start returns error when disabled', async () => {
    const result = await tun.start();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not enabled');
  });

  test('start returns error in stub mode even when enabled', async () => {
    const tun2 = new TunStub({ enabled: true });
    const result = await tun2.start();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('stub mode');
  });

  test('stop returns ok', async () => {
    const result = await tun.stop();
    expect(result.ok).toBe(true);
  });

  test('getStatus reflects state', () => {
    const status = tun.getStatus();
    expect(status.active).toBe(false);
    expect(status.available).toBe(false);
    expect(status.config.enabled).toBe(false);
  });
});
