import { describe, expect, it } from 'vitest';
import type { EscalationInput } from '@weaver/engine';
import { parseSourceContract } from '@weaver/core';
import { renderIssueBody } from './escalate.js';

const contract = parseSourceContract({
  id: 'dawaadost',
  name: 'Dawaa Dost',
  type: 'pdp',
  target_url: 'https://www.dawaadost.com',
  collector_id: 'c_msz4k0rsm4wpfezt3',
  description: 'Extract medicine product details from a product page.',
  row_key: ['product_url'],
  inputs: { urls: ['https://www.dawaadost.com/medicine/pan-40mg-tablet-15s'] },
  schema: [
    {
      field: 'product_url',
      description: 'the canonical URL of this medicine product page',
      type: 'url',
      required: true,
    },
    {
      field: 'composition',
      description: 'the active ingredients of the medicine as listed on the page',
      type: 'string',
      required: true,
    },
  ],
});

function input(overrides: Partial<EscalationInput> = {}): EscalationInput {
  return {
    contract,
    incidentId: '8e90d9e5-b546-4bbb-aa51-c590177347b8',
    findings: [
      {
        code: 'fill_rate_below_contract',
        severity: 'broken',
        field: 'composition',
        message: '"composition" is present in only 13% of rows, below the contract floor of 80%',
        observed: '2 of 15 rows',
        expected: 'at least 80% of rows',
      },
    ],
    attempts: [],
    ...overrides,
  };
}

const attempt = {
  attempt: 1,
  strategy: 'describe-all' as const,
  prompt: '"composition" is present in only 13% of rows.',
  fields: ['composition'],
  previewRows: 1,
  reason: 'the preview satisfied the contract for "composition" across 1 row',
};

describe('renderIssueBody', () => {
  it('says the collector is unchanged when every fix was rejected at the gate', () => {
    const body = renderIssueBody(
      input({ attempts: [{ ...attempt, verdict: 'rejected', reason: 'still empty' }] }),
    );

    expect(body).toContain('The collector is unchanged');
    expect(body).toContain('approve --reject');
  });

  it('says the collector was changed when a fix was approved and then failed', () => {
    // These two paths leave the collector in different states. Telling whoever
    // picks this up that nothing changed, when a version was committed, would send
    // them looking in the wrong place.
    const body = renderIssueBody(input({ attempts: [{ ...attempt, verdict: 'approved' }] }));

    expect(body).toContain('The collector was changed and the change did not work');
    expect(body).toContain('Versions menu');
    expect(body).not.toContain('The collector is unchanged');
  });

  it('quotes every prompt and verdict, so the reader inherits the reasoning', () => {
    const body = renderIssueBody(input({ attempts: [{ ...attempt, verdict: 'approved' }] }));

    expect(body).toContain(attempt.prompt);
    expect(body).toContain('Preview returned 1 row(s)');
    expect(body).toContain('composition');
    expect(body).toContain('c_msz4k0rsm4wpfezt3');
  });

  it('names the incident so the timeline can be found', () => {
    expect(renderIssueBody(input())).toContain('8e90d9e5-b546-4bbb-aa51-c590177347b8');
  });
});
