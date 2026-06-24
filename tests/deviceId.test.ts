import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceId, createReplacementDeviceId } from "../src/deviceId";

test("createDeviceId uses the expected persisted peer-id format", () => {
  assert.equal(createDeviceId(() => 0.5), "device-8");
});

test("createReplacementDeviceId never preserves the reset peer identity", () => {
  const values = [0.5, 0.75];
  const replacement = createReplacementDeviceId(
    "device-8",
    () => values.shift() ?? 0.75,
  );

  assert.equal(replacement, "device-c");
});
