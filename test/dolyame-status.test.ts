import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOLYAME_STATUSES,
  DOLYAME_TERMINAL_STATUSES,
  DOLYAME_TRANSITIONS,
  canCancelDolyame,
  canCommitDolyame,
  canTransitionDolyame,
  canonicalDolyameStatus,
  isDolyameStatusReachable,
  isTerminalDolyameStatus,
  shouldApplyDolyameStatus,
  type DolyameStatus,
} from "../src/index.js";

test("the lifecycle map covers every documented status except the wait_for_commit alias", () => {
  const keys = Object.keys(DOLYAME_TRANSITIONS).sort();
  const expected = DOLYAME_STATUSES.filter((s) => s !== "waiting_for_commit").sort();
  assert.deepEqual(keys, expected);
  for (const targets of Object.values(DOLYAME_TRANSITIONS)) {
    for (const target of targets) assert.ok(keys.includes(target), `${target} is a known status`);
  }
});

test("documented happy path: new -> approved -> wait_for_commit -> committed -> completed", () => {
  const path: DolyameStatus[] = ["new", "approved", "wait_for_commit", "committed", "completed"];
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransitionDolyame(path[i] as DolyameStatus, path[i + 1] as DolyameStatus), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test("documented exits: rejection after the check, cancellation by timeout/cancel call", () => {
  assert.equal(canTransitionDolyame("new", "rejected"), true);
  assert.equal(canTransitionDolyame("new", "canceled"), true); // 24 h without payment
  assert.equal(canTransitionDolyame("approved", "canceled"), true);
  assert.equal(canTransitionDolyame("wait_for_commit", "canceled"), true); // cancel call or 72 h without commit
});

test("steps that the documentation does not describe are refused", () => {
  assert.equal(canTransitionDolyame("committed", "canceled"), false);
  assert.equal(canTransitionDolyame("completed", "wait_for_commit"), false);
  assert.equal(canTransitionDolyame("rejected", "approved"), false);
  assert.equal(canTransitionDolyame("canceled", "approved"), false);
  assert.equal(canTransitionDolyame("new", "completed"), false); // direct step; see reachability below
  assert.equal(canTransitionDolyame("approved", "rejected"), false);
});

test("terminal statuses have no way out", () => {
  assert.deepEqual([...DOLYAME_TERMINAL_STATUSES].sort(), ["canceled", "completed", "rejected"]);
  for (const status of DOLYAME_TERMINAL_STATUSES) {
    assert.deepEqual(DOLYAME_TRANSITIONS[status], []);
    assert.equal(isTerminalDolyameStatus(status), true);
  }
  assert.equal(isTerminalDolyameStatus("wait_for_commit"), false);
});

test("waiting_for_commit is treated as wait_for_commit everywhere", () => {
  assert.equal(canonicalDolyameStatus("waiting_for_commit"), "wait_for_commit");
  assert.equal(canTransitionDolyame("approved", "waiting_for_commit"), true);
  assert.equal(canTransitionDolyame("waiting_for_commit", "committed"), true);
  assert.equal(canCommitDolyame("waiting_for_commit"), true);
  assert.equal(shouldApplyDolyameStatus("wait_for_commit", "waiting_for_commit"), false);
});

test("reachability tolerates lost intermediate webhooks", () => {
  assert.equal(isDolyameStatusReachable("new", "completed"), true);
  assert.equal(isDolyameStatusReachable("approved", "completed"), true);
  assert.equal(isDolyameStatusReachable("completed", "new"), false);
  assert.equal(isDolyameStatusReachable("committed", "canceled"), false);
  assert.equal(isDolyameStatusReachable("canceled", "completed"), false);
});

test("shouldApplyDolyameStatus ignores duplicates and late, out-of-order notifications", () => {
  assert.equal(shouldApplyDolyameStatus("approved", "approved"), false); // duplicate
  assert.equal(shouldApplyDolyameStatus("committed", "approved"), false); // late webhook
  assert.equal(shouldApplyDolyameStatus("completed", "committed"), false);
  assert.equal(shouldApplyDolyameStatus("canceled", "committed"), false); // never resurrect a cancelled order
  assert.equal(shouldApplyDolyameStatus("approved", "wait_for_commit"), true);
  assert.equal(shouldApplyDolyameStatus("approved", "committed"), true); // wait_for_commit webhook was lost
  assert.equal(shouldApplyDolyameStatus("new", "rejected"), true);
});

test("commit and cancel are allowed only in wait_for_commit (per the documentation)", () => {
  for (const status of DOLYAME_STATUSES) {
    const expected = status === "wait_for_commit" || status === "waiting_for_commit";
    assert.equal(canCommitDolyame(status), expected, `commit in ${status}`);
    assert.equal(canCancelDolyame(status), expected, `cancel in ${status}`);
  }
});
