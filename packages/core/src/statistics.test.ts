import { describe, expect, it } from 'vitest';
import type { FieldContract } from './contract.js';
import { median, percentChange, readFieldValue } from './statistics.js';

function field(overrides: Partial<FieldContract> = {}): FieldContract {
  return {
    field: 'mrp',
    description: 'the printed maximum retail price in rupees',
    type: 'number',
    required: true,
    minFillRate: 0.9,
    ...overrides,
  };
}

describe('readFieldValue', () => {
  describe('absence', () => {
    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['whitespace', '   '],
    ])('treats %s as missing rather than invalid', (_label, raw) => {
      expect(readFieldValue(field(), raw).kind).toBe('missing');
    });
  });

  describe('numbers', () => {
    it('accepts a plain number without marking it coerced', () => {
      expect(readFieldValue(field(), 214.5)).toEqual({
        kind: 'value',
        value: 214.5,
        coerced: false,
      });
    });

    it('coerces a rupee-formatted price, because real pages return them', () => {
      expect(readFieldValue(field(), '₹1,214.50')).toEqual({
        kind: 'value',
        value: 1214.5,
        coerced: true,
      });
    });

    it('rejects text that contains no number', () => {
      const result = readFieldValue(field(), 'Price on request');

      expect(result.kind).toBe('invalid');
    });

    it('enforces the contract range', () => {
      const result = readFieldValue(field({ validate: { gt: 0, lt: 100000 } }), -5);

      expect(result).toMatchObject({ kind: 'invalid' });
    });

    it('rejects a fractional value for an integer field', () => {
      const result = readFieldValue(field({ type: 'integer' }), 2.5);

      expect(result).toMatchObject({ kind: 'invalid' });
    });
  });

  describe('booleans', () => {
    it.each([
      ['in stock', true],
      ['Out Of Stock', false],
      ['yes', true],
    ])('reads %s as %s', (raw, expected) => {
      expect(readFieldValue(field({ field: 'in_stock', type: 'boolean' }), raw)).toEqual({
        kind: 'value',
        value: expected,
        coerced: true,
      });
    });

    it('rejects a string that is not a stock status', () => {
      expect(readFieldValue(field({ field: 'in_stock', type: 'boolean' }), 'limited').kind).toBe(
        'invalid',
      );
    });
  });

  describe('urls', () => {
    it('accepts an https url', () => {
      expect(
        readFieldValue(field({ field: 'product_url', type: 'url' }), 'https://a.test/p/1').kind,
      ).toBe('value');
    });

    it('rejects a bare path', () => {
      expect(readFieldValue(field({ field: 'product_url', type: 'url' }), '/p/1').kind).toBe(
        'invalid',
      );
    });

    it('rejects a non-http scheme', () => {
      expect(
        readFieldValue(field({ field: 'product_url', type: 'url' }), 'ftp://a.test/p').kind,
      ).toBe('invalid');
    });
  });

  describe('strings', () => {
    it('enforces one_of', () => {
      const currency = field({ field: 'currency', type: 'string', validate: { oneOf: ['INR'] } });

      expect(readFieldValue(currency, 'INR').kind).toBe('value');
      expect(readFieldValue(currency, 'USD').kind).toBe('invalid');
    });

    it('enforces min_length', () => {
      const name = field({ field: 'product_name', type: 'string', validate: { minLength: 3 } });

      expect(readFieldValue(name, 'ab').kind).toBe('invalid');
    });
  });
});

describe('median', () => {
  it('takes the middle of an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middles of an even-length list', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('returns 0 for an empty list rather than NaN', () => {
    expect(median([])).toBe(0);
  });
});

describe('percentChange', () => {
  it('measures an increase', () => {
    expect(percentChange(100, 150)).toBe(50);
  });

  it('measures a decrease', () => {
    expect(percentChange(100, 40)).toBe(-60);
  });

  it('treats any movement away from zero as total', () => {
    expect(percentChange(0, 5)).toBe(100);
  });

  it('reports no change from zero to zero', () => {
    expect(percentChange(0, 0)).toBe(0);
  });
});
