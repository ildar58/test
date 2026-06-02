import { describe, it, expect } from 'vitest';
import { parseDatasetConfig } from '../script-config';

describe('parseDatasetConfig', () => {
  it('returns {} for an empty dataset', () => {
    expect(parseDatasetConfig({})).toEqual({});
  });

  it('maps string attributes to their config keys', () => {
    expect(
      parseDatasetConfig({
        endpoint: '/custom/s/',
        markerCookie: 'pres',
        sessionIdCookie: 'sid',
        blockClass: 'no-rec',
        ignoreClass: 'no-input',
        maskTextClass: 'masked',
      })
    ).toEqual({
      endpoint: '/custom/s/',
      markerCookieName: 'pres',
      sessionIdCookieName: 'sid',
      blockClass: 'no-rec',
      ignoreClass: 'no-input',
      maskTextClass: 'masked',
    });
  });

  it('coerces number attributes', () => {
    expect(
      parseDatasetConfig({
        flushIntervalMs: '500',
        markerPollMs: '2000',
        maxBufferSize: '100',
        checkoutEveryMs: '60000',
        unauthorizedThreshold: '5',
        unauthorizedCooldownMs: '30000',
      })
    ).toEqual({
      flushIntervalMs: 500,
      markerPollMs: 2000,
      maxBufferSize: 100,
      checkoutEveryNms: 60000,
      unauthorizedThreshold: 5,
      unauthorizedCooldownMs: 30000,
    });
  });

  it('coerces boolean attributes', () => {
    expect(
      parseDatasetConfig({
        maskAllInputs: 'true',
        inlineStylesheet: 'false',
        collectFonts: 'true',
        recordCrossOriginIframes: 'false',
      })
    ).toEqual({
      maskAllInputs: true,
      inlineStylesheet: false,
      collectFonts: true,
      recordCrossOriginIframes: false,
    });
  });

  it('ignores unknown attributes', () => {
    expect(parseDatasetConfig({ foo: 'bar', endpoint: '/s/' })).toEqual({ endpoint: '/s/' });
  });

  it('drops malformed / empty numbers', () => {
    expect(parseDatasetConfig({ flushIntervalMs: 'abc', markerPollMs: '' })).toEqual({});
  });

  it('drops malformed booleans (not exactly "true"/"false")', () => {
    expect(parseDatasetConfig({ maskAllInputs: 'yes', collectFonts: '1' })).toEqual({});
  });

  it('drops empty string values', () => {
    expect(parseDatasetConfig({ endpoint: '' })).toEqual({});
  });
});
