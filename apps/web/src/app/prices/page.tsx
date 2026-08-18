import { Empty, SectionHeading, Tag } from '@/components/primitives';
import { loadPriceComparisons } from '@/lib/data';
import { formatPercent, formatRupees } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * The product the structured output powers.
 *
 * Every price here is shown per unit as well as per pack, because the three
 * pharmacies sell the same molecules in different pack sizes and comparing pack
 * prices produces a confidently wrong answer. Where the pack size had to be
 * inferred from the product name rather than read from a field, the table says so.
 */
export default async function PricesPage() {
  const comparisons = await loadPriceComparisons();

  return (
    <div>
      <SectionHeading eyebrow="What the data powers" title="Same medicine, three pharmacies">
        Grouped by composition rather than by brand, so two makers of the same molecule are compared
        against each other, and normalised to price per tablet so different pack sizes are
        comparable. Sorted by the saving available.
      </SectionHeading>

      {comparisons.length === 0 ? (
        <Empty>
          Nothing to compare yet. Collect from at least two sources, then this page fills itself.
        </Empty>
      ) : (
        <div className="space-y-6">
          {comparisons.map((comparison, index) => (
            <article
              key={comparison.molecule}
              data-reveal
              style={{ '--reveal-index': index } as React.CSSProperties}
              className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-6 py-5">
                <div>
                  <h3 className="font-serif text-2xl tracking-[-0.02em]">{comparison.molecule}</h3>
                  <p className="mt-1 font-mono text-[11px] text-muted">
                    {comparison.offers.length} offers ·{' '}
                    {new Set(comparison.offers.map((offer) => offer.sourceId)).size} pharmacies
                  </p>
                </div>
                <div className="text-right">
                  <div className="font-serif text-3xl leading-none tracking-[-0.02em] text-state-ok-ink">
                    {formatPercent(comparison.savingsPct)}
                  </div>
                  <div className="mt-1 font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                    saving per unit
                  </div>
                </div>
              </header>

              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line font-mono text-[10px] tracking-[0.1em] text-muted uppercase">
                    <th scope="col" className="px-6 py-3 font-normal">
                      Pharmacy
                    </th>
                    <th scope="col" className="px-6 py-3 font-normal">
                      Product
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Pack price
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Pack
                    </th>
                    <th scope="col" className="px-6 py-3 text-right font-normal">
                      Per unit
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.offers.map((offer) => {
                    const isCheapest = offer === comparison.cheapest;
                    return (
                      <tr
                        key={`${offer.sourceId}-${offer.productUrl}`}
                        className="border-b border-line last:border-0"
                      >
                        <td className="px-6 py-4">
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-[12px]">{offer.sourceId}</span>
                            {isCheapest && <Tag state="ok">cheapest</Tag>}
                          </span>
                        </td>
                        <td className="max-w-xs px-6 py-4">
                          <a
                            href={offer.productUrl}
                            rel="noreferrer noopener nofollow"
                            target="_blank"
                            className="underline decoration-line decoration-1 underline-offset-4 hover:decoration-ink"
                          >
                            {offer.productName}
                          </a>
                        </td>
                        <td className="numeric px-6 py-4 text-right">
                          {formatRupees(offer.sellingPrice)}
                          {offer.mrp !== undefined && offer.mrp > offer.sellingPrice && (
                            <span className="ml-2 text-[11px] text-muted line-through">
                              {formatRupees(offer.mrp)}
                            </span>
                          )}
                        </td>
                        <td className="numeric px-6 py-4 text-right">
                          {offer.packCount}
                          {offer.packSource !== 'field' && (
                            <span
                              className="ml-1 cursor-help text-[11px] text-muted"
                              title={`pack size ${offer.packSource} from the product name, not read from a field`}
                            >
                              ?
                            </span>
                          )}
                        </td>
                        <td
                          className={`numeric px-6 py-4 text-right ${isCheapest ? 'text-state-ok-ink' : ''}`}
                        >
                          {formatRupees(offer.pricePerUnit)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </article>
          ))}
        </div>
      )}

      <aside className="mt-12 rounded-[var(--radius-card)] border border-line bg-surface-sunk px-6 py-5 text-sm text-muted">
        <p>
          A <span className="font-mono text-[12px]">?</span> beside a pack size means it was
          inferred from the product name rather than read from a{' '}
          <span className="font-mono text-[12px]">pack_size</span> field. That field is added to the
          collectors by a heal, which is why the contract asks for it before the scraper produces
          it.
        </p>
      </aside>
    </div>
  );
}
