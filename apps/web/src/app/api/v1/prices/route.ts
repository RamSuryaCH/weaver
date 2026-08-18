import { NextResponse } from 'next/server';
import { loadPriceComparisons } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/prices
 *
 * The comparison, as JSON, for anything downstream that is not a browser. Same
 * function the dashboard calls, so the two cannot disagree about what "cheapest"
 * means.
 *
 * Public and unauthenticated by design: it serves only public product data that
 * is already published on three public websites, and it is read-only. Anything
 * that mutates a collector lives behind the CLI and the MCP server, never here.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const molecule = new URL(request.url).searchParams.get('molecule')?.trim().toLowerCase();
  const all = await loadPriceComparisons();

  const comparisons =
    molecule === undefined || molecule === ''
      ? all
      : all.filter(
          (comparison) =>
            comparison.molecule.includes(molecule) ||
            comparison.offers.some((offer) => offer.productName.toLowerCase().includes(molecule)),
        );

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    count: comparisons.length,
    comparisons: comparisons.map((comparison) => ({
      molecule: comparison.molecule,
      savingsPct: comparison.savingsPct,
      spreadPct: comparison.spreadPct,
      cheapest: {
        sourceId: comparison.cheapest.sourceId,
        pricePerUnit: comparison.cheapest.pricePerUnit,
        productUrl: comparison.cheapest.productUrl,
      },
      offers: comparison.offers.map((offer) => ({
        sourceId: offer.sourceId,
        productName: offer.productName,
        productUrl: offer.productUrl,
        currency: offer.currency,
        mrp: offer.mrp ?? null,
        sellingPrice: offer.sellingPrice,
        packCount: offer.packCount,
        packSource: offer.packSource,
        pricePerUnit: offer.pricePerUnit,
        inStock: offer.inStock ?? null,
      })),
    })),
  });
}
