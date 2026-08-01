"use strict";

/**
 * Tests for killswitch.js — kill switch for non-proxy traffic (#4).
 * Tests the public API: arm(), disarm(), status().
 * Firewall commands are mocked to avoid requiring admin privileges.
 */

// Mock child_process before importing killswitch
const mockExecSync = jest.fn(() => "");
jest.mock("node:child_process", () => ({
  execSync: mockExecSync,
  exec: jest.fn(),
}));

const killswitch = require("../src/killswitch");

describe("killswitch", () => {
  beforeEach(() => {
    mockExecSync.mockClear();
  });

  describe("arm()", () => {
    test("arms in strict mode by default", () => {
      const result = killswitch.arm();
      expect(result.armed).toBe(true);
      expect(result.mode).toBe("strict");
      expect(Array.isArray(result.rules)).toBe(true);
      expect(result.rules.length).toBeGreaterThan(0);
    });

    test("arms in soft mode when specified", () => {
      const result = killswitch.arm({ mode: "soft" });
      expect(result.armed).toBe(true);
      expect(result.mode).toBe("soft");
    });

    test("accepts custom proxy ports", () => {
      const result = killswitch.arm({ proxyPorts: [9999, 9998] });
      expect(result.armed).toBe(true);
    });

    test("accepts custom whitelist subnets", () => {
      const result = killswitch.arm({
        whitelistSubnets: ["10.0.0.0/8", "192.168.0.0/16"],
      });
      expect(result.armed).toBe(true);
    });
  });

  describe("disarm()", () => {
    test("disarms and returns cleaned rules", () => {
      killswitch.arm();
      const result = killswitch.disarm();
      expect(result.disarmed).toBe(true);
      expect(Array.isArray(result.cleaned)).toBe(true);
    });

    test("can disarm without prior arm", () => {
      const result = killswitch.disarm();
      expect(result.disarmed).toBe(true);
    });
  });

  describe("status()", () => {
    test("returns status object", () => {
      const result = killswitch.status();
      expect(typeof result.active).toBe("boolean");
      expect(typeof result.platform).toBe("string");
      expect(
        result.rulesCount === null || typeof result.rulesCount === "number"
      ).toBe(true);
    });
  });
});
