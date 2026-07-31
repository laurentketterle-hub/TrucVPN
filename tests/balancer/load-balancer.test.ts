import { LoadBalancer, ExitNode } from '../../src/balancer/load-balancer';

function makeExit(id: string, load: number, max: number, latency: number): ExitNode {
  return { id, host: `exit-${id}.trucvpn.local`, port: 8443, currentLoad: load, maxLoad: max, latencyMs: latency };
}

describe('LoadBalancer', () => {
  let lb: LoadBalancer;

  beforeEach(() => {
    lb = new LoadBalancer();
  });

  test('returns null when no exits', () => {
    expect(lb.selectExit()).toBeNull();
  });

  test('returns null when all exits full', () => {
    lb.addExit(makeExit('a', 10, 10, 20));
    expect(lb.selectExit()).toBeNull();
  });

  test('selects available exit (least-loaded default)', () => {
    lb.addExit(makeExit('a', 8, 10, 20));
    lb.addExit(makeExit('b', 2, 10, 15));
    const exit = lb.selectExit();
    expect(exit).not.toBeNull();
    expect(exit!.id).toBe('b');
  });

  test('round-robin strategy cycles', () => {
    lb = new LoadBalancer({ strategy: 'round-robin' });
    lb.addExit(makeExit('a', 0, 10, 20));
    lb.addExit(makeExit('b', 0, 10, 20));
    expect(lb.selectExit()!.id).toBe('a');
    expect(lb.selectExit()!.id).toBe('b');
    expect(lb.selectExit()!.id).toBe('a');
  });

  test('lowest-latency strategy', () => {
    lb = new LoadBalancer({ strategy: 'lowest-latency' });
    lb.addExit(makeExit('a', 0, 10, 100));
    lb.addExit(makeExit('b', 0, 10, 10));
    expect(lb.selectExit()!.id).toBe('b');
  });

  test('getStats returns correct counts', () => {
    lb.addExit(makeExit('a', 10, 10, 20));
    lb.addExit(makeExit('b', 0, 10, 20));
    const stats = lb.getStats();
    expect(stats.total).toBe(2);
    expect(stats.available).toBe(1);
    expect(stats.strategy).toBe('least-loaded');
  });

  test('removeExit works', () => {
    lb.addExit(makeExit('a', 0, 10, 20));
    lb.removeExit('a');
    expect(lb.getExits()).toHaveLength(0);
  });

  test('addExit adds node', () => {
    const exit = makeExit('x', 0, 5, 50);
    lb.addExit(exit);
    expect(lb.getExits()).toHaveLength(1);
    expect(lb.getExits()[0].id).toBe('x');
  });
});
