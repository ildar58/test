import type { PlayerEngine, EngineEvent, EngineEventHandler, EngineMountOptions } from '../types';
import type { eventWithTime } from '@rrweb/types';

// Stub — replaced by the real engine in Task 11.
export class RrwebPlayerEngine implements PlayerEngine {
  mount(_screenEl: HTMLElement, _events: eventWithTime[], _opts: EngineMountOptions): void {
    throw new Error('rrweb-player engine not implemented yet');
  }
  play(): void {}
  pause(): void {}
  seek(): void {}
  setSpeed(): void {}
  setSkipInactive(): void {}
  getDuration(): number { return 0; }
  getCurrentTime(): number { return 0; }
  resize(): void {}
  on(_event: EngineEvent, _handler: EngineEventHandler): void {}
  destroy(): void {}
}
