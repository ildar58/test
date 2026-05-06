import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../config';

describe('DEFAULT_CONFIG', () => {
  it('has privacy-safe defaults: all inputs masked, password always masked, fonts not collected', () => {
    expect(DEFAULT_CONFIG.maskAllInputs).toBe(true);
    expect(DEFAULT_CONFIG.maskInputOptions.password).toBe(true);
    expect(DEFAULT_CONFIG.collectFonts).toBe(false);
    expect(DEFAULT_CONFIG.recordCrossOriginIframes).toBe(false);
  });

  it('uses rec-* class prefixes (not ph-* like PostHog)', () => {
    expect(DEFAULT_CONFIG.blockClass).toBe('rec-no-capture');
    expect(DEFAULT_CONFIG.maskTextClass).toBe('rec-mask');
    expect(DEFAULT_CONFIG.ignoreClass).toBe('rec-ignore-input');
  });

  it('default flush interval is 2 seconds, checkout is 30 minutes', () => {
    expect(DEFAULT_CONFIG.flushIntervalMs).toBe(2_000);
    expect(DEFAULT_CONFIG.checkoutEveryNms).toBe(30 * 60 * 1000);
  });

  it('is not mutated when spread with overrides (immutability check)', () => {
    const before = JSON.stringify(DEFAULT_CONFIG);
    const merged = { ...DEFAULT_CONFIG, endpoint: 'https://other.example/s/' };
    expect(merged.endpoint).toBe('https://other.example/s/');
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
  });
});
