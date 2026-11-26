import { describe, expect, it } from 'vitest';
import { cryptoRng, seededRng } from '../src/core/rng.js';

describe('rng', () => {
  it('cryptoRng renvoie des valeurs dans [0, 1) sans lever d’erreur', () => {
    const values = Array.from({ length: 2_000 }, () => cryptoRng());
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // Uniformité grossière : moyenne proche de 0,5 et des valeurs bien réparties.
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(new Set(values).size).toBe(values.length);
  });

  it('seededRng est déterministe', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
