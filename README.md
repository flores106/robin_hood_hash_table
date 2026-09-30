# Robin Hood Hash Table

A small ESM TypeScript-free JavaScript library implementing a Robin Hood hash
table — collisions are resolved by displacing the entry with the shorter probe
sequence, reducing variance in lookup cost.

```js
import { RobinHoodMap } from "./src/index.js";

const table = new RobinHoodMap();
table.set("alpha", 1);
table.set("beta", 2);
console.log(table.get("alpha")); // 1
console.log(table.has("beta"));  // true
table.delete("alpha");
console.log(table.size);         // 1
table.clear();
```

Exports:
- `RobinHoodMap` — the table class. Constructor accepts `{ initialCapacity, hash, equals }`.
- `LOAD_FACTOR_THRESHOLD` — the resize trigger (0.7).

Methods: `get(key)`, `set(key, value)`, `has(key)`, `delete(key)`, `clear()`,
`size` (getter).

## Why

Standard open-addressing hash tables degrade badly when a handful of keys
hash to the same bucket: those keys form a long probe chain while neighbouring
slots sit empty, so a few lookups become slow while most stay fast. Robin Hood
hashing removes that variance by stealing from the rich: when a key being
inserted has probed further than a key already in a slot, the two are swapped
and the displaced key continues probing. The result is that all keys in a
collision cluster end up with similar probe lengths, and the worst-case lookup
stays close to `ln(n)` rather than `n`.

Trade-off: the worst case is still `O(n)` for a pathologically bad hash, and
the insertion cost is slightly higher due to swaps. We accept that for the
predictability of lookups.

## Edge cases

- `null` and `undefined` are valid keys (the default hash stringifies them with
  distinct prefixes).
- Object keys are held by identity unless you supply a custom `equals`. The
  default hash coerces objects to string, so two `{id: 1}` objects will collide
  on the same hash but compare unequal — pass a custom `hash`/`equals` pair if
  you need value semantics.
- The table grows when `size + tombstones` exceeds 70% of capacity. A high
  rate of deletes followed by inserts will trigger a rehash to compact away
  tombstones.

Run the tests:

```
node --test
```

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

