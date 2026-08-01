"use strict";

const tun = require("../src/tun");

describe("tun — WireGuard/Wintun path", () => {
  describe("checkTunSupport()", () => {
    test("returns support info for current platform", () => {
      const result = tun.checkTunSupport();
      expect(typeof result.supported).toBe("boolean");
      expect(typeof result.platform).toBe("string");
      expect(
        result.supported === true || typeof result.reason === "string"
      ).toBe(true);
    });
  });

  describe("generateWireGuardConfig()", () => {
    test("generates valid WireGuard config", () => {
      const result = tun.generateWireGuardConfig({
        exitId: "test-exit",
        exitHost: "10.0.0.1",
        exitPort: 51820,
      });

      expect(typeof result.config).toBe("string");
      expect(result.config).toContain("[Interface]");
      expect(result.config).toContain("[Peer]");
      expect(result.config).toContain("PrivateKey");
      expect(result.config).toContain("PublicKey");
      expect(result.config).toContain("Endpoint = 10.0.0.1:51820");

      expect(result.interface.privateKey).toBeTruthy();
      expect(result.interface.address).toContain("10.200.0.2/24");
      expect(result.peer.publicKey).toBeTruthy();
    });

    test("uses default exit when no opts provided", () => {
      const result = tun.generateWireGuardConfig();
      expect(result.config).toContain("127.0.0.1:51820");
    });
  });

  describe("initializeTun()", () => {
    test("throws on unsupported platform (or returns initialized stubs)", async () => {
      // On most CI platforms TUN is not supported — this should throw
      try {
        const result = await tun.initializeTun();
        expect(result.initialized).toBe(true);
        expect(result.tunInterface).toBeTruthy();
      } catch (err) {
        // Expected on platforms without TUN
        expect(err.message).toContain("TUN mode not supported");
      }
    });
  });

  describe("tunStatus()", () => {
    test("returns status object", () => {
      const result = tun.tunStatus();
      expect(typeof result.active).toBe("boolean");
      expect(typeof result.supported).toBe("boolean");
      expect(typeof result.platform).toBe("string");
    });
  });

  describe("shutdownTun()", () => {
    test("returns shutdown confirmation", async () => {
      const result = await tun.shutdownTun();
      expect(result.shutdown).toBe(true);
    });
  });
});
