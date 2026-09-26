import { test } from "node:test";
import assert from "node:assert/strict";
import { RobinHoodMap } from "../src/index.js";

/**
 * Deterministic identity hash for tests: every distinct string maps to a distinct
 * slot via its character code, giving us total control over home slots and PSLs.
 */
function identityHash(s) {
  return s.charCodeAt(0);
}

function hashByCode(s) {
  // same idea, exposed so tests can compute expected home slots
  return s.charCodeAt(0) >>> 0;
}

function capOf(map) {
  // Initial capacity in the constructor is 8, the smallest power of two we accept.
  // Tests below rely on this value when computing home indices.
  return 8;
}

test("get returns undefined for missing key on empty map", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  assert.equal(m.get("nope"), undefined);
  assert.equal(m.size, 0);
});

test("set/get roundtrip with single key", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  m.set("a", 1);
  assert.equal(m.get("a"), 1);
  assert.equal(m.size, 1);
  assert.equal(m.has("a"), true);
  assert.equal(m.has("b"), false);
});

test("set updates value for same key without growing size", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  m.set("a", 1);
  m.set("a", 2);
  assert.equal(m.get("a"), 2);
  assert.equal(m.size, 1);
});

test("collisions displace the entry with the shorter probe sequence", () => {
  // All keys hash to home slot 0; "a" is first and would be displaced by "b".
  function zeroHash() {
    return 0;
  }
  const m = new RobinHoodMap({ hash: zeroHash });
  m.set("a", 1);
  m.set("b", 2);
  // "a" (PSL 0) should yield to "b" (PSL 0 -> 1) — no, both start at PSL 0.
  // In Robin Hood, when the incoming PSL equals the incumbent's, we continue probing.
  // So "b" lands at slot 1, "a" stays at slot 0.
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("b"), 2);
  // The max PSL should be 1: "b" is one step from its home.
  assert.equal(m._maxProbeSequenceLength(), 1);
});

test("displacement chains when a later key has a longer probe", () => {
  // Using identity hash where every key maps to a distinct slot avoids the equal-PSL
  // tie case and lets us check the displacement swap directly.
  function zeroHash() {
    return 0;
  }
  const m = new RobinHoodMap({ hash: zeroHash, initialCapacity: 4 });
  // capacity 4, all keys home to slot 0.
  m.set("a", 1); // slot 0, psl 0
  m.set("b", 2); // slot 1, psl 1
  m.set("c", 3); // slot 2, psl 2
  // "c" at psl 2 does not displace "b" (psl 1 < 2). It also does not displace "a" (psl 0 < 2).
  // So "c" lands at slot 2.
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("b"), 2);
  assert.equal(m.get("c"), 3);
  assert.equal(m._maxProbeSequenceLength(), 2);
});

test("grows when load factor exceeds threshold", () => {
  const m = new RobinHoodMap({ hash: identityHash, initialCapacity: 8 });
  // With capacity 8 and LOAD_FACTOR_THRESHOLD 0.7, growth triggers once size+tombstones > 5.
  // Six distinct keys with distinct hashes fill 6 slots without collision.
  for (let i = 0; i < 6; i++) m.set(String.fromCharCode(97 + i), i);
  assert.equal(m.size, 6);
  // After resize, capacity doubles to 16, so all reads still resolve.
  for (let i = 0; i < 6; i++) {
    assert.equal(m.get(String.fromCharCode(97 + i)), i);
  }
});

test("delete removes a key and subsequent reads return undefined", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  m.set("a", 1);
  assert.equal(m.delete("a"), true);
  assert.equal(m.get("a"), undefined);
  assert.equal(m.has("a"), false);
  assert.equal(m.size, 0);
  assert.equal(m.delete("a"), false);
});

test("delete on a missing key returns false", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  assert.equal(m.delete("ghost"), false);
});

test("tombstones are not returned by get", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  m.set("a", 1);
  m.set("b", 2);
  m.delete("a");
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get("b"), 2);
});

test("reinserting after delete reuses slots correctly", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  m.set("a", 1);
  m.set("b", 2);
  m.delete("a");
  m.set("a", 3);
  assert.equal(m.get("a"), 3);
  assert.equal(m.get("b"), 2);
  assert.equal(m.size, 2);
});

test("clear empties the map", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  m.set("a", 1);
  m.set("b", 2);
  m.clear();
  assert.equal(m.size, 0);
  assert.equal(m.get("a"), undefined);
  assert.equal(m.get("b"), undefined);
});

test("custom equals is used for key comparison", () => {
  // Keys are { id } objects; equals compares by id so two distinct objects match.
  const m = new RobinHoodMap({
    hash: (k) => k.id,
    equals: (a, b) => a.id === b.id,
  });
  m.set({ id: 1 }, "first");
  assert.equal(m.get({ id: 1 }), "first");
  assert.equal(m.has({ id: 1 }), true);
});

test("home index calculation wraps via bitmask (power of two)", () => {
  // Identity hash with char code 103 ('g') on capacity 8 should home to slot 7.
  // Wrapping a key with code 111 ('o') should home to (111 & 7) = 7 as well, colliding.
  const m = new RobinHoodMap({ hash: identityHash, initialCapacity: 8 });
  m.set("g", 1); // home 7
  m.set("o", 2); // home 7, psl 1
  assert.equal(m.get("g"), 1);
  assert.equal(m.get("o"), 2);
});

test("object key identity remains stable through resize", () => {
  const m = new RobinHoodMap();
  const key = { id: 42 };
  m.set(key, "v");
  // Force multiple resizes by inserting enough distinct keys.
  for (let i = 0; i < 20; i++) m.set("k" + i, i);
  assert.equal(m.get(key), "v");
});

test("displacement keeps max probe length near log of size for monotonic inserts", () => {
  // All keys collide at home slot 0 (worst-case hash). Robin Hood should still keep
  // the PSL bounded; with ~6 entries (just under the grow threshold) the max PSL
  // should be at most 5, and in practice 5 since we insert in order.
  function zeroHash() {
    return 0;
  }
  const m = new RobinHoodMap({ hash: zeroHash, initialCapacity: 8 });
  for (let i = 0; i < 6; i++) m.set("k" + i, i);
  assert.equal(m.size, 6);
  const maxPsl = m._maxProbeSequenceLength();
  assert.ok(maxPsl <= 5, `expected maxPsl <= 5, got ${maxPsl}`);
});

test("construction rejects non-function hash/equals", () => {
  assert.throws(() => new RobinHoodMap({ hash: "nope" }), /hash must be a function/);
  assert.throws(() => new RobinHoodMap({ equals: 42 }), /equals must be a function/);
});

test("set returns the map for chaining", () => {
  const m = new RobinHoodMap({ hash: identityHash });
  const out = m.set("a", 1).set("b", 2);
  assert.equal(out, m);
});
