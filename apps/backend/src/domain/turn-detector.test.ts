import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector } from "./turn-detector";

test("starts once when prob crosses the start threshold", () => {
  const d = new TurnDetector();
  assert.deepEqual(d.observe(0.6), { started: true, ended: false });
  assert.deepEqual(d.observe(0.9), { started: false, ended: false });
  assert.equal(d.isSpeaking, true);
});

test("ends only after hangoverFrames of sub-end-threshold frames", () => {
  const d = new TurnDetector(0.5, 0.35, 3);
  d.observe(0.6); // start
  assert.deepEqual(d.observe(0.1), { started: false, ended: false });
  assert.deepEqual(d.observe(0.1), { started: false, ended: false });
  assert.deepEqual(d.observe(0.1), { started: false, ended: true });
  assert.equal(d.isSpeaking, false);
});

test("a frame at/above the end threshold resets the silence count", () => {
  const d = new TurnDetector(0.5, 0.35, 3);
  d.observe(0.6);
  d.observe(0.1);
  d.observe(0.1);
  assert.deepEqual(d.observe(0.4), { started: false, ended: false }); // resets count
  d.observe(0.1);
  d.observe(0.1);
  assert.deepEqual(d.observe(0.1), { started: false, ended: true });
});
