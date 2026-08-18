import { describe, expect, it } from 'vitest';
import { CREATE_DESCRIPTION_MAX_CHARS, findField, parseSourceContract } from './contract.js';

/** A minimal contract that parses cleanly. Tests mutate copies of this. */
function validContractInput(): Record<string, unknown> {
  return {
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    inputs: { urls: ['https://www.truemeds.in/medicine/example-123'] },
    schema: [
      {
        field: 'product_url',
        description: 'the canonical URL of the product page being scraped',
        type: 'url',
        required: true,
      },
      {
        field: 'mrp',
        description: 'the printed maximum retail price in rupees, before any discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { median_shift_pct: 25, flag_constant: true },
      },
    ],
  };
}

describe('parseSourceContract', () => {
  it('parses a valid contract and maps snake_case YAML to camelCase domain fields', () => {
    const contract = parseSourceContract(validContractInput());

    expect(contract.id).toBe('truemeds');
    expect(contract.targetUrl).toBe('https://www.truemeds.in');
    expect(contract.rowKey).toEqual(['product_url']);
    expect(contract.inputs.urls).toEqual(['https://www.truemeds.in/medicine/example-123']);

    const mrp = findField(contract, 'mrp');
    expect(mrp?.validate?.lt).toBe(100000);
    expect(mrp?.drift?.medianShiftPct).toBe(25);
    expect(mrp?.drift?.flagConstant).toBe(true);
  });

  it('defaults the heal policy to gated, so unattended approval is always opt-in', () => {
    const contract = parseSourceContract(validContractInput());

    expect(contract.policy.heal).toBe('gated');
    expect(contract.policy.maxHealAttempts).toBe(3);
  });

  it('defaults collectorId to null so a contract can exist before the scraper does', () => {
    const contract = parseSourceContract(validContractInput());

    expect(contract.collectorId).toBeNull();
  });

  it('accepts a Bright Data collector id', () => {
    const contract = parseSourceContract({
      ...validContractInput(),
      collector_id: 'c_mpohus372o5tmid1jk',
    });

    expect(contract.collectorId).toBe('c_mpohus372o5tmid1jk');
  });

  it('rejects a collector id that is not in Bright Data c_* form', () => {
    expect(() =>
      parseSourceContract({ ...validContractInput(), collector_id: 'collector-123' }),
    ).toThrow();
  });

  describe('fill rate defaults', () => {
    it('defaults required fields to 0.9', () => {
      const contract = parseSourceContract(validContractInput());

      expect(findField(contract, 'mrp')?.minFillRate).toBe(0.9);
    });

    it('defaults optional fields to 0, because the AI schema omits absent fields per row', () => {
      const input = validContractInput();
      (input.schema as Record<string, unknown>[]).push({
        field: 'discount_pct',
        description: 'the advertised discount percentage, when the product shows one',
        type: 'number',
      });

      const contract = parseSourceContract(input);

      expect(findField(contract, 'discount_pct')?.minFillRate).toBe(0);
    });

    it('honours an explicit min_fill_rate over the default', () => {
      const input = validContractInput();
      (input.schema as Record<string, unknown>[])[1] = {
        field: 'mrp',
        description: 'the printed maximum retail price in rupees, before any discount',
        type: 'number',
        required: true,
        min_fill_rate: 0.5,
      };

      const contract = parseSourceContract(input);

      expect(findField(contract, 'mrp')?.minFillRate).toBe(0.5);
    });
  });

  describe('rejected contracts', () => {
    it('rejects a create description longer than the CLI limit', () => {
      const input = {
        ...validContractInput(),
        description: 'x'.repeat(CREATE_DESCRIPTION_MAX_CHARS + 1),
      };

      expect(() => parseSourceContract(input)).toThrow();
    });

    it('rejects a field description too short to heal from', () => {
      const input = validContractInput();
      (input.schema as Record<string, unknown>[])[1] = {
        field: 'mrp',
        description: 'price',
        type: 'number',
      };

      expect(() => parseSourceContract(input)).toThrow();
    });

    it('rejects unknown keys, so a typo in YAML fails loudly instead of silently', () => {
      expect(() => parseSourceContract({ ...validContractInput(), min_row: 5 })).toThrow();
    });

    it('rejects duplicate field names', () => {
      const input = validContractInput();
      (input.schema as Record<string, unknown>[]).push({
        field: 'mrp',
        description: 'a second declaration of the same field name, which is a mistake',
        type: 'number',
      });

      expect(() => parseSourceContract(input)).toThrow(/duplicate field names/);
    });

    it('rejects a row_key that names a field not in the schema', () => {
      expect(() => parseSourceContract({ ...validContractInput(), row_key: ['sku'] })).toThrow(
        /row_key "sku" is not a field/,
      );
    });

    it('rejects median drift thresholds on non-numeric fields', () => {
      const input = validContractInput();
      (input.schema as Record<string, unknown>[])[0] = {
        field: 'product_url',
        description: 'the canonical URL of the product page being scraped',
        type: 'url',
        required: true,
        drift: { median_shift_pct: 10 },
      };

      expect(() => parseSourceContract(input)).toThrow(/median_shift_pct but is not numeric/);
    });

    it('rejects a field name that is not lower_snake_case', () => {
      const input = validContractInput();
      (input.schema as Record<string, unknown>[])[1] = {
        field: 'MRP',
        description: 'the printed maximum retail price in rupees, before any discount',
        type: 'number',
      };

      expect(() => parseSourceContract(input)).toThrow();
    });
  });

  describe('input requirements per scraper type', () => {
    it('requires urls for a pdp source', () => {
      const input = { ...validContractInput(), inputs: {} };

      expect(() => parseSourceContract(input)).toThrow(/requires inputs.urls/);
    });

    it('requires keywords for a search source, which takes no URL at all', () => {
      const input = { ...validContractInput(), type: 'search', inputs: {} };

      expect(() => parseSourceContract(input)).toThrow(/requires inputs.keywords/);
    });

    it('accepts a search source with keywords and no urls', () => {
      const contract = parseSourceContract({
        ...validContractInput(),
        type: 'search',
        inputs: { keywords: ['amoxicillin 500mg'] },
      });

      expect(contract.type).toBe('search');
      expect(contract.inputs.keywords).toEqual(['amoxicillin 500mg']);
    });

    it('requires sitemaps for a sitemap source', () => {
      const input = { ...validContractInput(), type: 'sitemap', inputs: {} };

      expect(() => parseSourceContract(input)).toThrow(/requires inputs.sitemaps/);
    });
  });
});
