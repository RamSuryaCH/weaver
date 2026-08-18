import { describe, expect, it } from 'vitest';
import { parseSourceContract, type SourceContract } from './contract.js';
import { describeVerdict, verifyPreview } from './preview.js';

function contract(): SourceContract {
  return parseSourceContract({
    id: 'truemeds',
    name: 'Truemeds',
    type: 'pdp',
    target_url: 'https://www.truemeds.in',
    description: 'Extract medicine product details from a product page.',
    row_key: ['product_url'],
    // A preview will never satisfy this, which is exactly why preview
    // verification must ignore run-level expectations.
    expectations: { min_rows: 12, max_row_drop_pct: 30 },
    inputs: { urls: ['https://www.truemeds.in/medicine/a'] },
    schema: [
      {
        field: 'product_url',
        description: 'the canonical URL of this medicine product page',
        type: 'url',
        required: true,
        min_fill_rate: 1,
      },
      {
        field: 'mrp',
        description: 'the printed maximum retail price in rupees, before any discount',
        type: 'number',
        required: true,
        validate: { gt: 0, lt: 100000 },
        drift: { flag_constant: true },
      },
    ],
  });
}

const GOOD_ROW = {
  product_url: 'https://www.truemeds.in/medicine/pan-40',
  mrp: 214.5,
};

describe('verifyPreview', () => {
  it('accepts a single good row, because a preview is a sample not a run', () => {
    const verdict = verifyPreview({ contract: contract(), fields: ['mrp'], rows: [GOOD_ROW] });

    expect(verdict.ok).toBe(true);
    expect(verdict.rowsInspected).toBe(1);
  });

  it('rejects an empty preview', () => {
    const verdict = verifyPreview({ contract: contract(), fields: ['mrp'], rows: [] });

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toEqual(['the preview contained no rows']);
  });

  it('rejects a preview where the healed field is still empty', () => {
    const verdict = verifyPreview({
      contract: contract(),
      fields: ['mrp'],
      rows: [{ ...GOOD_ROW, mrp: null }],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain('still empty');
  });

  it('rejects a preview where the healed field breaks the contract rules', () => {
    const verdict = verifyPreview({
      contract: contract(),
      fields: ['mrp'],
      rows: [{ ...GOOD_ROW, mrp: 0 }],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain('unusable');
  });

  it('rejects a fix that returns the same value for every product', () => {
    // The AI can satisfy "mrp must be a number" by latching onto a static
    // element. That is not a repair, and the gate has to notice.
    const rows = Array.from({ length: 5 }, (_unused, index) => ({
      product_url: `https://www.truemeds.in/medicine/p-${index}`,
      mrp: 249,
    }));

    const verdict = verifyPreview({ contract: contract(), fields: ['mrp'], rows });

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain('still latched onto');
  });

  it('tolerates a repeated value in a preview too small to judge', () => {
    const rows = [GOOD_ROW, { ...GOOD_ROW, product_url: 'https://a.test/2' }];

    expect(verifyPreview({ contract: contract(), fields: ['mrp'], rows }).ok).toBe(true);
  });

  it('judges only the fields the heal was asked to repair', () => {
    // product_url is broken, but this heal was about mrp. Failing here would
    // loop forever on a problem the fix was never asked to solve.
    const verdict = verifyPreview({
      contract: contract(),
      fields: ['mrp'],
      rows: [{ product_url: 'not-a-url', mrp: 214.5 }],
    });

    expect(verdict.ok).toBe(true);
  });

  it('reports a field name that is not in the contract at all', () => {
    const verdict = verifyPreview({
      contract: contract(),
      fields: ['price_per_unit'],
      rows: [GOOD_ROW],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.reasons[0]).toContain('not a field in the contract');
  });

  it('accepts a coerced value, because "₹214.50" is formatting not breakage', () => {
    const verdict = verifyPreview({
      contract: contract(),
      fields: ['mrp'],
      rows: [{ ...GOOD_ROW, mrp: '₹214.50' }],
    });

    expect(verdict.ok).toBe(true);
  });
});

describe('describeVerdict', () => {
  it('states what was checked when the preview passes', () => {
    const verdict = verifyPreview({ contract: contract(), fields: ['mrp'], rows: [GOOD_ROW] });

    expect(describeVerdict(verdict)).toBe(
      'the preview satisfied the contract for "mrp" across 1 row',
    );
  });

  it('joins the reasons when it fails, ready for the sharpened prompt', () => {
    const verdict = verifyPreview({
      contract: contract(),
      fields: ['mrp'],
      rows: [{ ...GOOD_ROW, mrp: null }],
    });

    expect(describeVerdict(verdict)).toContain('still empty');
  });
});
