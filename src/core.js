/**
 * Robin Hood hash table implementation, ESM.
 *
 * Storage layout per slot:
 *   - status: EMPTY | TOMBSTONE | OCCUPIED
 *   - key
 *   - value
 *   - hash
 *   - PSL (probe sequence length from the *ideal* home slot)
 *
 * Why we cache hash alongside the key: when a displacement candidate is found we must
 * compare PSLs without recomputing the hash of the stored key; with a user-supplied
 * key type the hash function is opaque, so caching it keeps the common path O(1).
 */

export const LOAD_FACTOR_THRESHOLD = 0.7;

export class RobinHoodMap {
  #capacity;
  #size;
  #tombstones;
  #slots;
  #hashfn;
  #equals;
  #valueMemory;

  /**
   * @param {object} [opts]
   * @param {number} [opts.initialCapacity=8]  Power of two (coerced up).
   * @param {function} [opts.hash]            32-bit integer hash of a key.
   * @param {function} [opts.equals]          Strict equality on keys.
   */
  constructor({
    initialCapacity = 8,
    hash = defaultHash,
    equals = defaultEquals,
  } = {}) {
    if (typeof hash !== "function") throw new TypeError("hash must be a function");
    if (typeof equals !== "function") throw new TypeError("equals must be a function");
    let cap = toPowerOfTwo(initialCapacity);
    if (cap < 4) cap = 4;
    this.#capacity = cap;
    this.#size = 0;
    this.#tombstones = 0;
    this.#slots = makeSlots(cap);
    this.#hashfn = hash;
    this.#equals = equals;
    this.#valueMemory = new WeakMap();
  }

  get size() {
    return this.#size;
  }

  /**
   * Public entry point. Uses key->path memoization to bypass probing entirely
   * when a key has been written and the table has not resized since.
   */
  get(key) {
    const path = this.#slotIndexOf(key);
    if (path !== undefined) {
      const slot = this.#slots[path];
      if (slot.status === OCCUPIED && slot.equalsKey(key, this.#equals)) {
        return slot.value;
      }
    }
    const p = this.#probeFind(key);
    if (p === -1) return undefined;
    return this.#slots[p].value;
  }

  set(key, value) {
    const hash = this.#hashfn(key) >>> 0;
    const home = hash & (this.#capacity - 1);
    const path = this.#insertAt(hash, home, key, value);
    this.#rememberKey(key, path, value);
    if (this.#size + this.#tombstones > this.#capacity * LOAD_FACTOR_THRESHOLD) {
      this.#grow();
    }
    return this;
  }

  has(key) {
    const path = this.#slotIndexOf(key);
    if (path !== undefined) {
      const slot = this.#slots[path];
      if (slot.status === OCCUPIED && slot.equalsKey(key, this.#equals)) {
        return true;
      }
    }
    return this.#probeFind(key) !== -1;
  }

  delete(key) {
    const path = this.#slotIndexOf(key);
    if (path !== undefined) {
      const slot = this.#slots[path];
      if (slot.status === OCCUPIED && slot.equalsKey(key, this.#equals)) {
        this.#markTombstone(path);
        this.#forgetKey(key);
        return true;
      }
    }
    const p = this.#probeFind(key);
    if (p === -1) return false;
    this.#markTombstone(p);
    const slot = this.#slots[p];
    this.#forgetKey(slot.key);
    return true;
  }

  clear() {
    this.#slots = makeSlots(this.#capacity);
    this.#size = 0;
    this.#tombstones = 0;
    this.#valueMemory = new WeakMap();
  }

  /**
   * Insert/update using Robin Hood displacement. When a new key would land at PSL `p`
   * but an existing key at that slot has a shorter PSL `q < p`, we swap and continue
   * inserting the evicted entry, accumulating its PSL. This keeps the maximum probe
   * length logarithmic rather than linear.
   */
  #insertAt(hash, home, key, value) {
    const cap = this.#capacity;
    const mask = cap - 1;
    const slots = this.#slots;

    let dist = 0;
    let curHash = hash;
    let curKey = key;
    let curVal = value;

    for (let attempts = 0; attempts < cap; attempts++) {
      const idx = (home + dist) & mask;
      const slot = slots[idx];

      if (slot.status === EMPTY || slot.status === TOMBSTONE) {
        slot.place(curHash, curKey, curVal, dist);
        if (slot.status === TOMBSTONE) this.#tombstones--;
        slot.status = OCCUPIED;
        this.#size++;
        return idx;
      }

      if (slot.status === OCCUPIED && slot.hash === curHash && this.#equals(slot.key, curKey)) {
        slot.value = curVal;
        if (slot.psl !== dist) slot.psl = dist;
        return idx;
      }

      if (slot.psl < dist) {
        const evHash = slot.hash;
        const evKey = slot.key;
        const evVal = slot.value;
        const evPsl = slot.psl;

        slot.place(curHash, curKey, curVal, dist);
        this.#rememberKey(curKey, idx, curVal);

        curHash = evHash;
        curKey = evKey;
        curVal = evVal;
        dist = evPsl + 1;
      } else {
        dist++;
      }
    }

    // Should be unreachable: at worst the resize policy forces a grow before the
    // table can become saturated, but defensive in case a user lowers it.
    this.#grow();
    return this.#insertAt(hash, home, key, value);
  }

  #probeFind(key) {
    const hash = this.#hashfn(key) >>> 0;
    const mask = this.#capacity - 1;
    const home = hash & mask;
    const slots = this.#slots;
    for (let dist = 0; dist <= this.#capacity; dist++) {
      const idx = (home + dist) & mask;
      const slot = slots[idx];
      if (slot.status === EMPTY) return -1;
      if (slot.status === OCCUPIED && slot.hash === hash && this.#equals(slot.key, key)) {
        return idx;
      }
      if (slot.status === OCCUPIED && slot.psl < dist) return -1;
    }
    return -1;
  }

  #markTombstone(idx) {
    const slot = this.#slots[idx];
    slot.status = TOMBSTONE;
    slot.key = undefined;
    slot.value = undefined;
    slot.hash = undefined;
    slot.psl = undefined;
    this.#size--;
    this.#tombstones++;
    // A high tombstone count degrades probe termination (every TOMBSTONE must be
    // stepped over) and inflates the load factor. Once they exceed a quarter of
    // the table, rehash to compact them away.
    if (this.#tombstones * 4 > this.#capacity) this.#rehash(this.#capacity);
  }

  #rehash(newCapacity) {
    const oldSlots = this.#slots;
    const oldCapacity = this.#capacity;
    this.#capacity = newCapacity;
    this.#size = 0;
    this.#tombstones = 0;
    this.#slots = makeSlots(newCapacity);
    this.#valueMemory = new WeakMap();
    for (let i = 0; i < oldCapacity; i++) {
      const s = oldSlots[i];
      if (s.status === OCCUPIED) {
        const home = s.hash & (newCapacity - 1);
        const idx = this.#insertAt(s.hash, home, s.key, s.value);
        this.#rememberKey(s.key, idx, s.value);
      }
    }
  }

  #grow() {
    this.#rehash(this.#capacity * 2);
  }

  /**
   * Memoize key -> slot index for O(1) lookups. Object keys use a WeakMap so
   * they can be garbage collected once no longer referenced elsewhere; primitive
   * keys fall back to probing.
   */
  #rememberKey(key, path, value) {
    if (key !== null && (typeof key === "object" || typeof key === "function")) {
      this.#valueMemory.set(key, { path, value });
    }
  }

  #forgetKey(key) {
    if (key !== null && (typeof key === "object" || typeof key === "function")) {
      this.#valueMemory.delete(key);
    }
  }

  #slotIndexOf(key) {
    if (key !== null && (typeof key === "object" || typeof key === "function")) {
      const memo = this.#valueMemory.get(key);
      if (memo !== undefined) return memo.path;
    }
    return undefined;
  }

  /**
   * For tests: the max PSL across occupied slots. A well-behaved Robin Hood table
   * keeps this near ln(n); a pathologically unbalanced hash pushes it higher.
   */
  _maxProbeSequenceLength() {
    let max = 0;
    for (let i = 0; i < this.#capacity; i++) {
      const s = this.#slots[i];
      if (s.status === OCCUPIED && s.psl > max) max = s.psl;
    }
    return max;
  }
}

// --- Slot ------------------------------------------------------------------

const EMPTY = 0;
const TOMBSTONE = 1;
const OCCUPIED = 2;

class Slot {
  constructor() {
    this.status = EMPTY;
    this.key = undefined;
    this.value = undefined;
    this.hash = undefined;
    this.psl = undefined;
  }

  place(hash, key, value, psl) {
    this.hash = hash;
    this.key = key;
    this.value = value;
    this.psl = psl;
  }

  equalsKey(key, equalsFn) {
    return this.status === OCCUPIED && equalsFn(this.key, key);
  }
}

function makeSlots(capacity) {
  const arr = new Array(capacity);
  for (let i = 0; i < capacity; i++) arr[i] = new Slot();
  return arr;
}

// --- Defaults ---------------------------------------------------------------

/**
 * FNV-1a 32-bit. Stable across processes, reasonable distribution for arbitrary
 * objects coerced to string. Production-grade hash functions are out of scope
 * for a zero-dependency library.
 */
function defaultHash(key) {
  let s;
  if (key === null) s = "\u0000null";
  else if (key === undefined) s = "\u0000undef";
  else if (typeof key === "object") s = String(key);
  else s = String(key);

  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function defaultEquals(a, b) {
  return a === b;
}

function toPowerOfTwo(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 4;
  let p = 1;
  while (p < n) p <<= 1;
  return p < 4 ? 4 : p;
}
