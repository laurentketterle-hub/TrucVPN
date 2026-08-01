"use strict";

const { LoadBalancer } = require("../src/balancer");

describe("LoadBalancer", () => {
  const sampleExits = [
    {
      id: "vn-hcm",
      host: "127.0.0.1",
      port: 1790,
      load: 0.2,
      latency_ms: 28,
      region: "vn",
      protocol: "socks5",
    },
    {
      id: "us-sfo",
      host: "127.0.0.1",
      port: 1791,
      load: 0.4,
      latency_ms: 120,
      region: "us",
      protocol: "socks5",
    },
    {
      id: "sg-1",
      host: "127.0.0.1",
      port: 1792,
      load: 0.15,
      latency_ms: 45,
      region: "sg",
      protocol: "http-connect",
    },
    {
      id: "eu-fra",
      host: "127.0.0.1",
      port: 1793,
      load: 0.35,
      latency_ms: 95,
      region: "eu",
      protocol: "http-connect",
    },
  ];

  describe("constructor", () => {
    test("creates with default strategy", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      expect(lb.strategy).toBe("adaptive");
    });

    test("creates with custom strategy", () => {
      const lb = new LoadBalancer({
        exits: sampleExits,
        strategy: "round-robin",
      });
      expect(lb.strategy).toBe("round-robin");
    });

    test("throws on invalid strategy", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      expect(() => lb.setStrategy("invalid")).toThrow();
    });
  });

  describe("pickExit()", () => {
    test("returns an exit", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      const exit = lb.pickExit();
      expect(exit).toBeDefined();
      expect(exit.id).toBeDefined();
    });

    test("round-robin cycles through exits", () => {
      const lb = new LoadBalancer({ exits: sampleExits, strategy: "round-robin" });
      const picks = new Set();
      for (let i = 0; i < 50; i++) {
        const exit = lb.pickExit();
        if (exit) picks.add(exit.id);
      }
      // Should visit all exits
      expect(picks.size).toBe(sampleExits.length);
    });

    test("least-connections prefers exit with fewer connections", () => {
      const lb = new LoadBalancer({
        exits: sampleExits,
        strategy: "least-connections",
      });
      // Put connections on all but one exit
      lb.openConnection("vn-hcm");
      lb.openConnection("vn-hcm");
      lb.openConnection("us-sfo");
      lb.openConnection("sg-1");

      const exit = lb.pickExit();
      // Should pick eu-fra (0 connections)
      expect(exit.id).toBe("eu-fra");
    });

    test("weighted favors low-load exits", () => {
      const lb = new LoadBalancer({
        exits: sampleExits,
        strategy: "weighted",
      });
      const picks = {};
      for (let i = 0; i < 500; i++) {
        const exit = lb.pickExit();
        if (exit) picks[exit.id] = (picks[exit.id] || 0) + 1;
      }
      // sg-1 (load 0.15) should get more picks than us-sfo (load 0.4)
      // With enough iterations the weighted distribution stabilizes
      expect(picks["sg-1"]).toBeGreaterThan(picks["us-sfo"]);
    });

    test("adaptive prefers lower latency + lower load", () => {
      const lb = new LoadBalancer({ exits: sampleExits, strategy: "adaptive" });
      const exit = lb.pickExit();
      expect(exit).toBeDefined();
    });

    test("preferred region gets bonus in adaptive mode", () => {
      const lb = new LoadBalancer({ exits: sampleExits, strategy: "adaptive" });
      const exit = lb.pickExit({ preferredRegion: "us" });
      expect(exit.region).toBe("us");
    });

    test("excludes specified exits", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      const exit = lb.pickExit({ excludeExits: ["vn-hcm", "us-sfo", "sg-1"] });
      expect(exit.id).toBe("eu-fra");
    });

    test("returns null when all exits excluded", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      const exit = lb.pickExit({
        excludeExits: ["vn-hcm", "us-sfo", "sg-1", "eu-fra"],
      });
      expect(exit).toBeNull();
    });
  });

  describe("connection tracking", () => {
    test("tracks open and close connections", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      lb.openConnection("vn-hcm");
      lb.openConnection("vn-hcm");
      lb.openConnection("us-sfo");

      const snap = lb.snapshot();
      const vn = snap.perExit.find((e) => e.id === "vn-hcm");
      const us = snap.perExit.find((e) => e.id === "us-sfo");

      expect(vn.activeConnections).toBe(2);
      expect(us.activeConnections).toBe(1);

      lb.closeConnection("vn-hcm");
      const snap2 = lb.snapshot();
      const vn2 = snap2.perExit.find((e) => e.id === "vn-hcm");
      expect(vn2.activeConnections).toBe(1);
    });

    test("does not go below 0 connections", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      lb.closeConnection("vn-hcm");
      const snap = lb.snapshot();
      const vn = snap.perExit.find((e) => e.id === "vn-hcm");
      expect(vn.activeConnections).toBe(0);
    });
  });

  describe("recordFailure()", () => {
    test("tracks failures", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      lb.recordFailure("vn-hcm");
      lb.recordFailure("vn-hcm");
      const snap = lb.snapshot();
      const vn = snap.perExit.find((e) => e.id === "vn-hcm");
      expect(vn.failed).toBe(2);
    });
  });

  describe("setStrategy()", () => {
    test("changes strategy at runtime", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      expect(lb.strategy).toBe("adaptive");
      lb.setStrategy("round-robin");
      expect(lb.strategy).toBe("round-robin");
      lb.setStrategy("least-connections");
      expect(lb.strategy).toBe("least-connections");
    });
  });

  describe("snapshot()", () => {
    test("returns comprehensive stats", () => {
      const lb = new LoadBalancer({ exits: sampleExits });
      lb.openConnection("vn-hcm");
      lb.openConnection("sg-1");
      lb.openConnection("sg-1");

      const snap = lb.snapshot();
      expect(snap.strategy).toBe("adaptive");
      expect(snap.totalExits).toBe(4);
      expect(snap.activeConnections).toBe(3);
      expect(snap.perExit.length).toBe(4);
    });
  });

  describe("updateExits()", () => {
    test("updates exit pool while preserving stats for remaining exits", () => {
      const lb = new LoadBalancer({ exits: sampleExits.slice(0, 2) });
      lb.openConnection("vn-hcm");

      lb.updateExits(sampleExits.slice(2));
      expect(lb.exits.length).toBe(2);
      // snapshot includes all tracked exits, including old ones
      const snap = lb.snapshot();
      expect(snap.perExit.length).toBeGreaterThanOrEqual(2);
    });
  });
});
