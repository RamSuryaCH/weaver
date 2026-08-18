import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATE_DESCRIPTION_MAX_CHARS } from '@weaver/core';
import { ContractLoadError, loadSourceContracts, parseContractYaml } from './sources.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourcesDir = resolve(repoRoot, 'sources');

const MINIMAL_YAML = `
id: example
name: Example Pharmacy
type: pdp
target_url: https://example.test
description: Extract the product name and price from this product page.
row_key:
  - product_url
inputs:
  urls:
    - https://example.test/product/1
schema:
  - field: product_url
    description: the canonical URL of this product page
    type: url
    required: true
  - field: selling_price
    description: the price in rupees a customer actually pays today
    type: number
    required: true
`;

describe('parseContractYaml', () => {
  it('parses YAML text into a contract', () => {
    const contract = parseContractYaml(MINIMAL_YAML, 'example.yaml');

    expect(contract.id).toBe('example');
    expect(contract.schema).toHaveLength(2);
  });

  it('wraps parse failures with the filename, so a typo points at the file', () => {
    const broken = MINIMAL_YAML.replace('type: pdp', 'type: nonsense');

    expect(() => parseContractYaml(broken, 'example.yaml')).toThrow(ContractLoadError);
    expect(() => parseContractYaml(broken, 'example.yaml')).toThrow(/example\.yaml/);
  });

  it('reports malformed YAML rather than crashing', () => {
    expect(() => parseContractYaml('id: [unclosed', 'example.yaml')).toThrow(ContractLoadError);
  });
});

describe('the contracts committed in sources/', () => {
  const contracts = loadSourceContracts(sourcesDir);

  it('all parse', () => {
    expect(contracts.length).toBeGreaterThanOrEqual(3);
  });

  it('are sorted by id, so CLI and dashboard output is stable', () => {
    const ids = contracts.map((contract) => contract.id);

    expect(ids).toEqual([...ids].sort());
  });

  it.each(contracts.map((contract) => [contract.id, contract] as const))(
    '%s has a create description within the Bright Data CLI limit',
    (_id, contract) => {
      // `bdata scraper create` rejects descriptions over 500 characters, and
      // finding that out after a 15-minute generation run is expensive.
      expect(contract.description.length).toBeLessThanOrEqual(CREATE_DESCRIPTION_MAX_CHARS);
    },
  );

  it.each(contracts.map((contract) => [contract.id, contract] as const))(
    '%s never targets a robots.txt-disallowed path',
    (_id, contract) => {
      // Every target site disallows /search and /cart. Weaver refuses to hold a
      // contract that would send a collector somewhere it is not allowed.
      const disallowed = [/\/search/, /\/cart/, /\/login/, /\/my-account/];
      const urls = contract.inputs.urls ?? [];

      for (const url of urls) {
        for (const pattern of disallowed) {
          expect(url).not.toMatch(pattern);
        }
      }
    },
  );

  it.each(contracts.map((contract) => [contract.id, contract] as const))(
    '%s expects fewer rows than it supplies inputs',
    (_id, contract) => {
      const inputCount = (contract.inputs.urls ?? []).length;

      expect(contract.expectations.minRows).toBeLessThanOrEqual(inputCount);
    },
  );
});
