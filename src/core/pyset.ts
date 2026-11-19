// Reimplements the iteration order of a Python `set` as CPython 3.12 produces it (Objects/setobject.c: make_new_set ->
// set_update_internal -> set_add_entry, set_table_resize, set_insert_clean). This is not code from pystitch: it is a
// TypeScript model of the hash-table insertion, linear/perturbed probing and resize steps of CPython, which is
// distributed under the Python Software Foundation License (see NOTICE).
//
// pystitch iterates Python sets in EmbThread.build_unique_palette and EmbPattern.get_unique_threadlist, and the PEC
// palette depends on that order, so this module is what lets the TS port write the same bytes. Verified against the
// real interpreter in test/core/pyset.test.ts.

const PySet_MINSIZE = 8;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5;

interface Table<T> {
  keys: Array<T | undefined>;
  hashes: number[];
  occupied: boolean[];
  /** Table size - 1 (a power of two minus one). */
  mask: number;
}

function newTable<T>(size: number): Table<T> {
  return { keys: new Array<T | undefined>(size), hashes: new Array<number>(size).fill(0), occupied: new Array<boolean>(size).fill(false), mask: size - 1 };
}

/** `(i * 5 + 1 + perturb) & mask` for size_t operands that stay below 2^53 here. */
function nextIndex(i: number, perturb: number, mask: number): number {
  return (i * 5 + 1 + perturb) % (mask + 1); // mask + 1 is a power of two and the operand is non-negative.
}

/** set_insert_clean: insert into a table known to hold no equal key and no dummy entries. */
function insertClean<T>(table: Table<T>, key: T, hash: number): void {
  const mask = table.mask;
  let perturb = hash;
  let i = hash % (mask + 1);
  for (;;) {
    if (!table.occupied[i]) {
      place(table, i, key, hash);
      return;
    }
    if (i + LINEAR_PROBES <= mask) {
      for (let j = 1; j <= LINEAR_PROBES; j++) {
        if (!table.occupied[i + j]) {
          place(table, i + j, key, hash);
          return;
        }
      }
    }
    perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT); // perturb >>= PERTURB_SHIFT (unsigned)
    i = nextIndex(i, perturb, mask);
  }
}

function place<T>(table: Table<T>, slot: number, key: T, hash: number): void {
  table.keys[slot] = key;
  table.hashes[slot] = hash;
  table.occupied[slot] = true;
}

/**
 * set_table_resize: the smallest power of two above `minused` (from PySet_MINSIZE), then every old entry is
 * reinserted in old-table slot order. No entry is ever deleted here, so fill == used and there are no dummies.
 */
function resize<T>(table: Table<T>, minused: number): Table<T> {
  let newsize = PySet_MINSIZE;
  while (newsize <= minused) newsize *= 2;
  const next = newTable<T>(newsize);
  for (let slot = 0; slot <= table.mask; slot++) {
    if (table.occupied[slot]) insertClean(next, table.keys[slot] as T, table.hashes[slot]);
  }
  return next;
}

/**
 * The items of `items` in the order CPython 3.12 iterates `set(items)`.
 *
 * - `hash(item)` must return Python's hash of the item: here only non-negative integers below 2^53, for which
 *   Python's int hash is the value itself as long as it is below 2^61 - 1 (EmbThread.__hash__ is color & 0xFFFFFF).
 * - `eq(existing, incoming)` is Python's `existing == incoming`, called only when the hashes are equal and the two
 *   are not the same object (PyObject_RichCompareBool short-cuts identity). The first inserted of equal items is kept.
 */
export function pySetOrder<T>(items: Iterable<T>, hash: (item: T) => number, eq: (existing: T, incoming: T) => boolean): T[] {
  let table = newTable<T>(PySet_MINSIZE);
  let fill = 0;
  let used = 0;
  for (const key of items) {
    const h = hash(key);
    if (!Number.isSafeInteger(h) || h < 0) throw new RangeError(`unsupported hash value ${h}`);
    // set_add_entry
    let mask = table.mask;
    let i = h % (mask + 1);
    let perturb = h;
    let done = false;
    while (!done) {
      let slot = i;
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      for (;;) {
        if (!table.occupied[slot]) {
          // found_unused
          place(table, slot, key, h);
          fill++;
          used++;
          if (fill * 5 >= mask * 3) {
            table = resize(table, used > 50000 ? used * 2 : used * 4);
            mask = table.mask;
            fill = used; // set_table_resize keeps fill == used (no dummies)
          }
          done = true;
          break;
        }
        if (table.hashes[slot] === h) {
          const startkey = table.keys[slot] as T;
          if (startkey === key || eq(startkey, key)) {
            done = true; // found_active: already present
            break;
          }
        }
        slot++;
        if (probes-- === 0) break; // do { ... } while (probes--);
      }
      if (done) break;
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = nextIndex(i, perturb, mask);
    }
  }
  const out: T[] = [];
  for (let slot = 0; slot <= table.mask; slot++) if (table.occupied[slot]) out.push(table.keys[slot] as T);
  return out;
}
