"use strict";

const { buildChain, validateChain } = require("../src/multihop");

// Mock upstream to avoid actual network
jest.mock("../src/proxy/upstream", () => ({
  connectViaExit: jest.fn().mockResolvedValue({
    on: jest.fn(),
    once: jest.fn(),
    write: jest.fn(),
    destroy: jest.fn(),
  }),
}));

describe("multihop", () => {
  const sampleExits = [
    { id: "vn-hcm", host: "127.0.0.1", port: 1790, latency_ms: 28, load: 0.2, region: "vn", protocol: "socks5" },
    { id: "us-sfo", host: "127.0.0.1", port: 1791, latency_ms: 120, load: 0.4, region: "us", protocol: "socks5" },
    { id: "sg-1", host: "127.0.0.1", port: 1792, latency_ms: 45, load: 0.15, region: "sg", protocol: "http-connect" },
    { id: "direct-local", host: "127.0.0.1", port: 0, latency_ms: 1, load: 0, region: "local", protocol: "direct" },
  ];

  describe("buildChain()", () => {
    test("builds chain from exit IDs", () => {
      const chain = buildChain(sampleExits, [{ exitId: "vn-hcm" }, { exitId: "us-sfo" }]);
      expect(chain.length).toBe(2);
      expect(chain[0].id).toBe("vn-hcm");
      expect(chain[1].id).toBe("us-sfo");
    });

    test("builds chain from strings", () => {
      const chain = buildChain(sampleExits, ["vn-hcm", "sg-1"]);
      expect(chain.length).toBe(2);
      expect(chain[0].id).toBe("vn-hcm");
      expect(chain[1].id).toBe("sg-1");
    });

    test("builds chain from region preferences", () => {
      const chain = buildChain(sampleExits, [
        { region: "vn" },
        { region: "us" },
      ]);
      expect(chain.length).toBe(2);
      expect(chain[0].region).toBe("vn");
      expect(chain[1].region).toBe("us");
    });

    test("filters out unknown exits", () => {
      const chain = buildChain(sampleExits, [
        { exitId: "vn-hcm" },
        { exitId: "nonexistent" },
        { exitId: "sg-1" },
      ]);
      expect(chain.length).toBe(2);
      expect(chain[0].id).toBe("vn-hcm");
      expect(chain[1].id).toBe("sg-1");
    });

    test("returns empty for null chain", () => {
      const chain = buildChain(sampleExits, null);
      expect(chain.length).toBe(0);
    });

    test("returns empty for empty chain", () => {
      const chain = buildChain(sampleExits, []);
      expect(chain.length).toBe(0);
    });
  });

  describe("validateChain()", () => {
    test("valid chain passes", () => {
      const chain = buildChain(sampleExits, ["vn-hcm", "us-sfo", "sg-1"]);
      const result = validateChain(chain);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test("empty chain fails", () => {
      const result = validateChain([]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("chain is empty");
    });

    test("non-array fails", () => {
      const result = validateChain("not-an-array");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("chain must be an array");
    });

    test("chain longer than 5 hops fails", () => {
      const exits = [
        { id: "e1", protocol: "socks5" },
        { id: "e2", protocol: "socks5" },
        { id: "e3", protocol: "socks5" },
        { id: "e4", protocol: "socks5" },
        { id: "e5", protocol: "socks5" },
        { id: "e6", protocol: "socks5" },
      ];
      const result = validateChain(exits);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("maximum"))).toBe(true);
    });

    test("duplicate exits fail", () => {
      const chain = buildChain(sampleExits, ["vn-hcm", "us-sfo", "vn-hcm"]);
      const result = validateChain(chain);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
    });
  });
});
