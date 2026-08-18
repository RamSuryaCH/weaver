/**
 * The vertical product: comparing the same medicine across pharmacies.
 *
 * The hard part is not scraping the prices, it is comparing them honestly. The
 * three sources sell the same molecules in different pack sizes — Pan 40 comes
 * as a strip of 10 on one site and 15 on another — so comparing the price on the
 * page would produce a confidently wrong answer. Everything is normalised to
 * price per unit before anything is called cheaper.
 *
 * Pure, like the rest of `@weaver/core`: rows in, comparisons out. The dashboard,
 * the read API and the MCP server all call this same function, so they cannot
 * disagree about what "cheapest" means.
 */

export interface PharmacyOffer {
  readonly sourceId: string;
  readonly productUrl: string;
  readonly productName: string;
  readonly composition: string;
  readonly mrp: number | undefined;
  readonly sellingPrice: number;
  readonly currency: string;
  readonly discountPct: number | undefined;
  readonly inStock: boolean | undefined;
  /** Units in the pack: tablets, capsules, millilitres. */
  readonly packCount: number;
  /** How `packCount` was established. `inferred` is weaker evidence. */
  readonly packSource: 'field' | 'inferred' | 'assumed';
  readonly pricePerUnit: number;
}

export interface MoleculeComparison {
  /** Normalised composition, the key products are grouped by. */
  readonly molecule: string;
  readonly offers: readonly PharmacyOffer[];
  readonly cheapest: PharmacyOffer;
  readonly dearest: PharmacyOffer;
  /** How much more the dearest costs than the cheapest, per unit. */
  readonly spreadPct: number;
  /** What a buyer saves by choosing the cheapest, as a percentage. */
  readonly savingsPct: number;
}

/**
 * Read one collected row into an offer.
 *
 * Returns null rather than throwing: a row that cannot be compared should be
 * skipped in a price table, not crash it. Weaver's drift engine is the thing
 * that complains about bad rows.
 */
export function readOffer(sourceId: string, row: unknown): PharmacyOffer | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;

  const productUrl = asString(record.product_url);
  const productName = asString(record.product_name);
  const composition = asString(record.composition);
  const sellingPrice = asNumber(record.selling_price);

  if (productUrl === undefined || productName === undefined || sellingPrice === undefined) {
    return null;
  }
  if (composition === undefined) return null;

  const pack = resolvePackCount(record, productName, productUrl);

  return {
    sourceId,
    productUrl,
    productName,
    composition,
    mrp: asNumber(record.mrp),
    sellingPrice,
    currency: asString(record.currency) ?? 'INR',
    discountPct: asNumber(record.discount_pct),
    inStock: asBoolean(record.in_stock),
    packCount: pack.count,
    packSource: pack.source,
    pricePerUnit: round(sellingPrice / pack.count, 4),
  };
}

/**
 * Normalise a composition into a grouping key.
 *
 * "Cinnarizine + Domperidone 20mg+15mg" and "cinnarizine+domperidone" are the
 * same medicine, and a price comparison that misses that is useless. Salt names
 * are sorted so ingredient order cannot split a group.
 */
export function moleculeKey(composition: string): string {
  const withoutStrengths = composition
    .toLowerCase()
    .replace(/\d+(\.\d+)?\s*(mg|mcg|ml|g|iu|%)/g, ' ')
    .replace(/\(.*?\)/g, ' ');

  const salts = withoutStrengths
    .split(/[+,/&]|\band\b/)
    .map((part) => part.replace(/[^a-z\s-]/g, '').trim())
    .filter((part) => part.length > 2)
    .sort();

  return salts.length === 0 ? composition.trim().toLowerCase() : salts.join('+');
}

/**
 * Units in a pack.
 *
 * Read from an explicit `pack_size` field when the collector provides one. Until
 * it does, it is inferred from the product name or URL, which encode it on all
 * three sites ("Tablet 15", "tablet-15s", "60ml"). Inference is marked as such
 * so the dashboard can be honest about the weaker evidence.
 */
function resolvePackCount(
  record: Record<string, unknown>,
  productName: string,
  productUrl: string,
): { count: number; source: PharmacyOffer['packSource'] } {
  const declared = parsePackSize(asString(record.pack_size));
  if (declared !== undefined) return { count: declared, source: 'field' };

  const fromName = parsePackSize(productName) ?? parsePackSize(lastSegment(productUrl));
  if (fromName !== undefined) return { count: fromName, source: 'inferred' };

  // One unit is the safest assumption: it compares pack against pack, which is
  // wrong but never silently scaled.
  return { count: 1, source: 'assumed' };
}

/**
 * Extract a unit count from text such as "Tablet 15", "tablet-15s" or "60ml".
 *
 * Order matters, and getting it wrong is worse than returning nothing. "Pan 40
 * Tablet 10" contains two numbers: 40 is the strength in milligrams and 10 is
 * the pack. A pattern of "number followed by the word tablet" reads that as a
 * pack of 40 and then quietly divides the price by four times too much. So the
 * unambiguous markers are tried first, and the ambiguous "number before the form
 * word" case is only accepted when the form word is plural.
 */
export function parsePackSize(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const normalised = text.toLowerCase();

  // 1. "15s", "tablet-15s", "20 s" — a pack marker with no other meaning.
  const strip = /(\d+)\s*s\b/.exec(normalised);
  if (strip !== null) return positive(Number(strip[1]));

  // 2. "Tablet 15", "capsule 10", "strip of 15" — the count follows the form.
  const trailing = /(?:tablet|capsule|sachet|strip)s?\s+(?:of\s+)?(\d+)/.exec(normalised);
  if (trailing !== null) return positive(Number(trailing[1]));

  // 3. "15 tablets" — plural only, so a strength like "40 Tablet" cannot match.
  const counted = /(\d+)\s*(?:tablets|capsules|sachets|pieces)\b/.exec(normalised);
  if (counted !== null) return positive(Number(counted[1]));

  // 4. Liquids: "60ml", "100 ml".
  const millilitres = /(\d+)\s*ml\b/.exec(normalised);
  if (millilitres !== null) return positive(Number(millilitres[1]));

  return undefined;
}

/**
 * Group offers by molecule and rank them by price per unit.
 *
 * Only molecules available from more than one source produce a comparison;
 * a single offer has nothing to be cheaper than.
 */
export function compareByMolecule(offers: readonly PharmacyOffer[]): readonly MoleculeComparison[] {
  const groups = new Map<string, PharmacyOffer[]>();

  for (const offer of offers) {
    const key = moleculeKey(offer.composition);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [offer]);
    else existing.push(offer);
  }

  const comparisons: MoleculeComparison[] = [];

  for (const [molecule, group] of groups) {
    const distinctSources = new Set(group.map((offer) => offer.sourceId));
    if (distinctSources.size < 2) continue;

    const ranked = [...group].sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    const cheapest = ranked[0]!;
    const dearest = ranked.at(-1)!;

    comparisons.push({
      molecule,
      offers: ranked,
      cheapest,
      dearest,
      spreadPct: round(
        ((dearest.pricePerUnit - cheapest.pricePerUnit) / cheapest.pricePerUnit) * 100,
        1,
      ),
      savingsPct: round(
        ((dearest.pricePerUnit - cheapest.pricePerUnit) / dearest.pricePerUnit) * 100,
        1,
      ),
    });
  }

  // Biggest savings first: that is the reason someone opened this page.
  return comparisons.sort((a, b) => b.savingsPct - a.savingsPct);
}

/** Read every collected row into offers, skipping rows that cannot be compared. */
export function readOffers(
  rows: readonly { readonly sourceId: string; readonly data: unknown }[],
): readonly PharmacyOffer[] {
  return rows
    .map((row) => readOffer(row.sourceId, row.data))
    .filter((offer): offer is PharmacyOffer => offer !== null);
}

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function lastSegment(url: string): string {
  return url.replace(/\/$/, '').split('/').at(-1) ?? '';
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(cleaned) ? cleaned : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (['true', 'yes', 'in stock', 'available'].includes(normalised)) return true;
    if (['false', 'no', 'out of stock', 'unavailable'].includes(normalised)) return false;
  }
  return undefined;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
