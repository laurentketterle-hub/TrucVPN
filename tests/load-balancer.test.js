"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { MultiUserLoadBalancer, createLoadBalancer } = require("../src/load-balancer");

const MOCK_EXITS = [
  { id: "exit-us", region: "us", load: 0.1, latency_ms: 50, protocol: "socks5", host: "127.0.0.1", port: 1080 },
  { id: "exit-eu", region: "eu", load: 0.3, latency_ms: 30, protocol: "http-connect", host: "127.0.0.1", port: 1081 },
  { id: "exit-asia", region: "sg", load: 0.5, latency_ms: 80, protocol: "socks5", host: "127.0.0.1", port: 1082 },
  { id: "exit-direct", region: "local", load: 0, latency_ms: 1, protocol: "direct" },
];

describe("MultiUserLoadBalancer", () => {
  describe("round-robin", () => {
    it("distributes users across exits cyclically", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "round-robin" });
      const sessions = [];
      for (let i = 0; i < 9; i++) {
        sessions.push(lb.assignExitForUser("user_" + i));
      }

      const allAssigned = sessions.every((s) => s.exit && s.exit.id);
      assert.ok(allAssigned, "all users must have an exit");

      // 3 residential exits, 9 users → each should get ~3
      const ids = sessions.map((s) => s.exit.id);
      assert.ok(ids.includes("exit-us"), "should include exit-us");
      assert.ok(ids.includes("exit-eu"), "should include exit-eu");
      assert.ok(ids.includes("exit-asia"), "should include exit-asia");

      // direct exit should NOT be used when residential exits are healthy
      assert.ok(!ids.includes("exit-direct"), "should not use direct when residential exits exist");
    });

    it("cycles in order", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "round-robin" });
      const s1 = lb.assignExitForUser("u1");
      const s2 = lb.assignExitForUser("u2");
      const s3 = lb.assignExitForUser("u3");
      const s4 = lb.assignExitForUser("u4");

      // After 3 residential exits, should wrap
      assert.equal(s1.exit.id, "exit-us");
      assert.equal(s2.exit.id, "exit-eu");
      assert.equal(s3.exit.id, "exit-asia");
      assert.equal(s4.exit.id, "exit-us");
    });
  });

  describe("least-loaded", () => {
    it("prefers low-load exits", () => {
      const exits = [
        { id: "exit-low", region: "us", load: 0.05, latency_ms: 40, protocol: "socks5", host: "127.0.0.1", port: 1080 },
        { id: "exit-high", region: "eu", load: 0.95, latency_ms: 30, protocol: "http-connect", host: "127.0.0.1", port: 1081 },
      ];
      const lb = new MultiUserLoadBalancer({ exits, strategy: "least-loaded" });

      const sessions = [];
      for (let i = 0; i < 10; i++) {
        sessions.push(lb.assignExitForUser("user_" + i));
      }

      // All should go to exit-low because least-loaded always picks the one with fewer users
      // (both start at 0, then tie-break on load)
      const lowCount = sessions.filter((s) => s.exit.id === "exit-low").length;
      assert.ok(lowCount >= 5, "least-loaded should prefer low-load exit");
    });
  });

  describe("sticky sessions", () => {
    it("returns same exit for same user on re-assign", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "round-robin", stickySessions: true });
      const s1 = lb.assignExitForUser("alice");
      const s2 = lb.assignExitForUser("bob");
      const s1b = lb.assignExitForUser("alice"); // re-assign alice

      assert.equal(s1.exit.id, s1b.exit.id, "sticky: same user should get same exit");
      assert.notEqual(s1.exit.id, s2.exit.id, "different users may get different exits");
    });

    it("reassigns if original exit becomes unhealthy", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "round-robin", stickySessions: true });
      const s1 = lb.assignExitForUser("alice");
      const originalId = s1.exit.id;

      lb.markUnhealthy(originalId);

      // Don't wait for timer — test that immediate reassign works
      // (markUnhealthy only sets a timeout; it's still in _unhealthy set)
      const s1b = lb.assignExitForUser("alice");
      assert.notEqual(s1b.exit.id, originalId, "should reassign away from unhealthy exit");
      assert.ok(!s1b.isFallback, "should still find another residential exit");
    });
  });

  describe("fallback to direct", () => {
    it("falls back to direct when all residential exits are unhealthy", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "round-robin" });

      // Mark all residential exits unhealthy
      lb.markUnhealthy("exit-us");
      lb.markUnhealthy("exit-eu");
      lb.markUnhealthy("exit-asia");

      const s = lb.assignExitForUser("user_fallback");
      assert.ok(s.isFallback, "should be fallback");
      assert.equal(s.exit.protocol, "direct", "should fall back to direct");
    });
  });

  describe("getStats", () => {
    it("reports balancer state", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "least-loaded", stickySessions: true });
      lb.assignExitForUser("u1");
      lb.assignExitForUser("u2");

      const stats = lb.getStats();
      assert.equal(stats.totalUsers, 2);
      assert.equal(stats.strategy, "least-loaded");
      assert.equal(stats.stickySessions, true);
      assert.ok(stats.exitsInRotation >= 1);
    });
  });

  describe("releaseUser", () => {
    it("decrements user count and frees user mapping", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "least-loaded" });
      lb.assignExitForUser("u1");
      lb.assignExitForUser("u1"); // re-assign (sticky) shouldn't double-count
      assert.equal(lb.getStats().totalUsers, 1);

      lb.releaseUser("u1");
      assert.equal(lb.getStats().totalUsers, 0);
    });
  });

  describe("region-affinity", () => {
    it("routes user to preferred region", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "region-affinity" });
      const s = lb.assignExitForUser("eu_user", "eu");
      assert.equal(s.exit.id, "exit-eu", "should route to eu exit");
    });

    it("falls back to round-robin when preferred region unavailable", () => {
      const lb = new MultiUserLoadBalancer({ exits: MOCK_EXITS, strategy: "region-affinity" });
      const s = lb.assignExitForUser("jp_user", "jp"); // no JP exit
      assert.ok(s.exit && s.exit.id, "should get some exit via fallback");
    });
  });

  describe("createLoadBalancer factory", () => {
    it("creates balancer from config", () => {
      const lb = createLoadBalancer(
        { lbStrategy: "least-loaded", lbStickySessions: false },
        MOCK_EXITS
      );
      const stats = lb.getStats();
      assert.equal(stats.strategy, "least-loaded");
      assert.equal(stats.stickySessions, false);
    });
  });
});
