import { describe, expect, it } from 'vitest';
import { readEnv } from './env.js';

describe('readEnv', () => {
  it('defaults to replay mode, so a fresh clone spends no credits', () => {
    const env = readEnv({});

    expect(env.mode).toBe('replay');
  });

  it('defaults the heal policy to gated, never auto', () => {
    const env = readEnv({});

    expect(env.healPolicy).toBe('gated');
  });

  it('treats a blank key as absent rather than as an empty credential', () => {
    const env = readEnv({ BRIGHTDATA_API_KEY: '   ' });

    expect(env.hasApiKey).toBe(false);
  });

  it('reports the key as present without exposing it', () => {
    const env = readEnv({ BRIGHTDATA_API_KEY: 'secret-value' });

    expect(env.hasApiKey).toBe(true);
    expect(JSON.stringify(env)).not.toContain('secret-value');
  });

  it('rejects an unknown run mode instead of silently falling back', () => {
    expect(() => readEnv({ WEAVER_MODE: 'production' })).toThrow();
  });

  it('rejects an escalation repo that is not owner/name', () => {
    expect(() => readEnv({ WEAVER_ESCALATION_REPO: 'not-a-repo' })).toThrow();
  });

  it('accepts a well-formed escalation repo', () => {
    const env = readEnv({ WEAVER_ESCALATION_REPO: 'RamSuryaCH/weaver' });

    expect(env.escalationRepo).toBe('RamSuryaCH/weaver');
  });
});
