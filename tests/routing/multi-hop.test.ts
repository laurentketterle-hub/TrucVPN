import { MultiHopRouter, HopConfig } from '../../src/routing/multi-hop';

function makeHop(id: string, priority: number): HopConfig {
  return { id, host: `${id}.trucvpn.local`, port: 8443, priority };
}

describe('MultiHopRouter', () => {
  let router: MultiHopRouter;

  beforeEach(() => {
    router = new MultiHopRouter(3);
  });

  test('selectHop returns null with no hops', () => {
    expect(router.selectHop()).toBeNull();
  });

  test('selects hop by priority', () => {
    router.addHop(makeHop('low', 10));
    router.addHop(makeHop('high', 1));
    const hop = router.selectHop();
    expect(hop!.id).toBe('high');
  });

  test('failover to next priority on failure', () => {
    router.addHop(makeHop('primary', 1));
    router.addHop(makeHop('secondary', 2));
    router.selectHop(); // primary
    router.recordFailure('primary');
    router.recordFailure('primary');
    router.recordFailure('primary'); // 3rd failure = exhausted
    const hop = router.selectHop();
    expect(hop!.id).toBe('secondary');
  });

  test('resetFailures restores all hops', () => {
    router.addHop(makeHop('a', 1));
    router.selectHop();
    router.recordFailure('a');
    router.recordFailure('a');
    router.recordFailure('a');
    router.resetFailures();
    const status = router.getStatusReport();
    expect(status.hops[0].active).toBe(true);
    expect(status.hops[0].failures).toBe(0);
  });

  test('recordSuccess resets failure count', () => {
    router.addHop(makeHop('a', 1));
    router.selectHop();
    router.recordFailure('a');
    router.recordFailure('a');
    router.recordSuccess('a', 15);
    const status = router.getStatusReport();
    expect(status.hops[0].failures).toBe(0);
    expect(status.hops[0].latencyMs).toBe(15);
  });

  test('getStatusReport shows all hops', () => {
    router.addHop(makeHop('a', 1));
    router.addHop(makeHop('b', 2));
    const report = router.getStatusReport();
    expect(report.hops).toHaveLength(2);
    expect(report.activeHop).toBeNull(); // not selected yet
  });

  test('removeHop cleans up', () => {
    router.addHop(makeHop('a', 1));
    router.removeHop('a');
    expect(router.getHopChain()).toHaveLength(0);
    expect(router.selectHop()).toBeNull();
  });

  test('getActiveHop returns current selection', () => {
    router.addHop(makeHop('a', 1));
    router.selectHop();
    const active = router.getActiveHop();
    expect(active).not.toBeNull();
    expect(active!.hop.id).toBe('a');
  });
});
