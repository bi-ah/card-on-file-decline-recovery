// Deterministic hashing for the simulators. A value depends only on its inputs,
// never on call order, so concurrent Workflows see the same results as a test.

export function hash32(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 1) from the inputs. */
export function unit(...parts: Array<string | number>): number {
  return hash32(...parts) / 4294967296;
}

/** Pick from weighted options with a unit value. */
export function pick<T>(u: number, options: Array<[T, number]>): T {
  const total = options.reduce((s, [, w]) => s + w, 0);
  let x = u * total;
  for (const [v, w] of options) {
    if (x < w) return v;
    x -= w;
  }
  return options[options.length - 1]![0];
}
