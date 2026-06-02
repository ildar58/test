import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ctorConfigs, startMock, stopMock } = vi.hoisted(() => ({
  ctorConfigs: [] as Array<Record<string, unknown>>,
  startMock: vi.fn(),
  stopMock: vi.fn(),
}));
vi.mock('../recorder', () => ({
  Recorder: vi.fn().mockImplementation((config: Record<string, unknown>) => {
    ctorConfigs.push(config);
    return { start: startMock, stop: stopMock };
  }),
}));

import { autoInit, stop } from '../index';
import { DEFAULT_CONFIG } from '../config';

describe('autoInit', () => {
  beforeEach(() => {
    ctorConfigs.length = 0;
    startMock.mockClear();
    stopMock.mockClear();
    stop(); // reset the init singleton between tests
  });

  it('does not construct a Recorder when the script is null', () => {
    autoInit(null);
    expect(ctorConfigs).toHaveLength(0);
  });

  it('merges data-* overrides over DEFAULT_CONFIG and starts', () => {
    const s = document.createElement('script');
    s.dataset.endpoint = '/custom/s/';
    s.dataset.flushIntervalMs = '500';
    autoInit(s);

    expect(ctorConfigs).toHaveLength(1);
    expect(ctorConfigs[0]!.endpoint).toBe('/custom/s/');
    expect(ctorConfigs[0]!.flushIntervalMs).toBe(500);
    expect(ctorConfigs[0]!.markerCookieName).toBe(DEFAULT_CONFIG.markerCookieName);
    expect(startMock).toHaveBeenCalledOnce();
  });
});
