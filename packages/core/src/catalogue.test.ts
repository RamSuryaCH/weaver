import { describe, expect, it } from 'vitest';
import {
  compareByMolecule,
  moleculeKey,
  parsePackSize,
  readOffer,
  readOffers,
} from './catalogue.js';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_url: 'https://www.truemeds.in/medicine/pan-40-mg-tablet-10-tm-tacr1-030124',
    product_name: 'Pan 40 Tablet 10',
    composition: 'pantoprazole 40mg',
    mrp: 214.5,
    selling_price: 182.3,
    currency: 'INR',
    discount_pct: 15,
    in_stock: true,
    ...overrides,
  };
}

describe('parsePackSize', () => {
  it.each([
    ['Pan 40mg Tablet 15s', 15],
    ['Glycomet 500mg Tablet 10s', 10],
    ['Pan 40 Tablet 10', 10],
    ['Zerodol SP Tablet', undefined],
    ['Sinarest Syrup 60ml', 60],
    ['Shelcal 500 Tablet 40', 40],
    ['pack of 15 tablets', 15],
  ])('reads %s as %s', (text, expected) => {
    expect(parsePackSize(text)).toBe(expected);
  });

  it('ignores nonsense sizes', () => {
    expect(parsePackSize('Tablet 0s')).toBeUndefined();
  });
});

describe('moleculeKey', () => {
  it('strips strengths so the same salt groups together', () => {
    expect(moleculeKey('Pantoprazole 40mg')).toBe(moleculeKey('pantoprazole'));
  });

  it('sorts salts so ingredient order cannot split a group', () => {
    expect(moleculeKey('cinnarizine+domperidone')).toBe(
      moleculeKey('Domperidone 15mg + Cinnarizine 20mg'),
    );
  });

  it('handles separators used across the three sites', () => {
    const slash = moleculeKey('amoxycillin / clavulanic acid');
    const plus = moleculeKey('Amoxycillin 500mg + Clavulanic Acid 125mg');

    expect(slash).toBe(plus);
  });

  it('keeps different molecules apart', () => {
    expect(moleculeKey('pantoprazole')).not.toBe(moleculeKey('omeprazole'));
  });
});

describe('readOffer', () => {
  it('reads a well-formed row and computes price per unit', () => {
    const offer = readOffer('truemeds', row())!;

    expect(offer.packCount).toBe(10);
    expect(offer.packSource).toBe('inferred');
    expect(offer.pricePerUnit).toBe(18.23);
  });

  it('prefers an explicit pack_size field over inference', () => {
    // pack_size is the field the real heal adds. Once it exists, guessing stops.
    const offer = readOffer('truemeds', row({ pack_size: '15 tablets' }))!;

    expect(offer.packCount).toBe(15);
    expect(offer.packSource).toBe('field');
  });

  it('falls back to one unit rather than silently scaling a price', () => {
    const offer = readOffer('truemeds', row({ product_name: 'Zerodol SP Tablet' }))!;

    expect(offer.packCount).toBe(1);
    expect(offer.packSource).toBe('assumed');
    expect(offer.pricePerUnit).toBe(182.3);
  });

  it('coerces a rupee-formatted price', () => {
    expect(readOffer('truemeds', row({ selling_price: '₹182.30' }))?.sellingPrice).toBe(182.3);
  });

  it('skips a row with no price rather than throwing', () => {
    expect(readOffer('truemeds', row({ selling_price: null }))).toBeNull();
  });

  it('skips a row with no composition, since it cannot be compared', () => {
    expect(readOffer('truemeds', row({ composition: null }))).toBeNull();
  });

  it('skips a value that is not a row at all', () => {
    expect(readOffer('truemeds', 'not a row')).toBeNull();
  });
});

describe('compareByMolecule', () => {
  /** The real shape of the problem: same molecule, three sites, three pack sizes. */
  function threeSites() {
    return readOffers([
      {
        sourceId: 'truemeds',
        data: row({ product_name: 'Pan 40 Tablet 10', selling_price: 182.3 }),
      },
      {
        sourceId: 'dawaadost',
        data: row({
          product_url: 'https://www.dawaadost.com/medicine/pan-40mg-tablet-15s',
          product_name: 'Pan 40mg Tablet 15s',
          selling_price: 210,
        }),
      },
      {
        sourceId: 'apollo-pharmacy',
        data: row({
          product_url: 'https://www.apollopharmacy.in/medicine/pan-40mg-tablet',
          product_name: 'Pan 40mg Tablet 15s',
          selling_price: 259.5,
        }),
      },
    ]);
  }

  it('ranks by price per unit, not by the price on the page', () => {
    // The headline result, and the reason this normalisation exists: Truemeds
    // shows the lowest price on the page (₹182.30) and is the most expensive
    // per tablet, because it sells 10 where the others sell 15. Comparing pack
    // prices would recommend the dearest option with total confidence.
    const [comparison] = compareByMolecule(threeSites());

    expect(comparison?.cheapest.sourceId).toBe('dawaadost');
    expect(comparison?.cheapest.pricePerUnit).toBe(14);
    expect(comparison?.dearest.sourceId).toBe('truemeds');
    expect(comparison?.dearest.pricePerUnit).toBe(18.23);
  });

  it('reports the saving a buyer actually makes', () => {
    const [comparison] = compareByMolecule(threeSites());

    // ₹14.00 per tablet against ₹18.23: a saving of 23%.
    expect(comparison?.savingsPct).toBeCloseTo(23.2, 1);
    expect(comparison?.spreadPct).toBeCloseTo(30.2, 1);
  });

  it('groups two brands of the same molecule together', () => {
    // Pan 40 and Pantop 40 are both pantoprazole 40mg from different makers.
    // This is the brand-versus-brand comparison the product exists to expose.
    const offers = readOffers([
      { sourceId: 'truemeds', data: row({ product_name: 'Pan 40 Tablet 10' }) },
      {
        sourceId: 'dawaadost',
        data: row({
          product_url: 'https://www.dawaadost.com/medicine/pantop-40mg-tablet-15s',
          product_name: 'Pantop 40mg Tablet 15s',
          composition: 'Pantoprazole 40 mg',
          selling_price: 168.3,
        }),
      },
    ]);

    const comparisons = compareByMolecule(offers);

    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.offers.map((offer) => offer.productName)).toEqual([
      'Pantop 40mg Tablet 15s',
      'Pan 40 Tablet 10',
    ]);
  });

  it('ignores a molecule only one pharmacy sells', () => {
    const offers = readOffers([{ sourceId: 'truemeds', data: row() }]);

    expect(compareByMolecule(offers)).toEqual([]);
  });

  it('does not compare a source against itself', () => {
    const offers = readOffers([
      { sourceId: 'truemeds', data: row({ selling_price: 100 }) },
      {
        sourceId: 'truemeds',
        data: row({
          product_url: 'https://www.truemeds.in/medicine/pan-40-mg-tablet-15-x',
          selling_price: 200,
        }),
      },
    ]);

    expect(compareByMolecule(offers)).toEqual([]);
  });

  it('puts the biggest saving first, because that is why the page was opened', () => {
    const offers = readOffers([
      { sourceId: 'truemeds', data: row({ selling_price: 100 }) },
      { sourceId: 'dawaadost', data: row({ selling_price: 95 }) },
      {
        sourceId: 'truemeds',
        data: row({
          product_url: 'https://www.truemeds.in/medicine/glycomet-500-mg-tablet-10-x',
          product_name: 'Glycomet 500 Tablet 10',
          composition: 'metformin 500mg',
          selling_price: 100,
        }),
      },
      {
        sourceId: 'dawaadost',
        data: row({
          product_url: 'https://www.dawaadost.com/medicine/glycomet-500mg-tablet-10s',
          product_name: 'Glycomet 500mg Tablet 10s',
          composition: 'Metformin 500 mg',
          selling_price: 40,
        }),
      },
    ]);

    const comparisons = compareByMolecule(offers);

    expect(comparisons[0]?.molecule).toBe('metformin');
    expect(comparisons[0]?.savingsPct).toBeGreaterThan(comparisons[1]!.savingsPct);
  });
});
