"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { createKillSwitch } = require("../src/killswitch");

test("killswitch: enabled blocks non-proxy", async () => {
  const ks = createKillSwitch({ enabled: true });
  assert.strictEqual(ks.check("8.8.8.8", 53), false, "should block DNS");
});

test("killswitch: disabled allows all", async () => {
  const ks = createKillSwitch({ enabled: false });
  assert.strictEqual(ks.check("8.8.8.8", 443), true, "should allow when disabled");
});

test("killswitch: allows proxy ports", async () => {
  const ks = createKillSwitch({ enabled: true, proxyPorts: [17880, 17881] });
  assert.strictEqual(ks.check("127.0.0.1", 17880), true, "should allow proxy port");
});

test("killswitch: blocks external ports", async () => {
  const ks = createKillSwitch({ enabled: true, proxyPorts: [17880] });
  assert.strictEqual(ks.check("93.184.216.34", 443), false, "should block external");
});

test("killswitch: toggle works", () => {
  const ks = createKillSwitch({ enabled: true });
  assert.strictEqual(ks.isEnabled(), true);
  ks.disable();
  assert.strictEqual(ks.isEnabled(), false);
  ks.enable();
  assert.strictEqual(ks.isEnabled(), true);
});

test("killswitch: status report", () => {
  const ks = createKillSwitch({ enabled: true });
  const status = ks.getStatus();
  assert.strictEqual(status.enabled, true);
});
