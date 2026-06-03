import rrwebPlayer from 'rrweb-player';
import type { eventWithTime } from '@rrweb/types';
import type { PlayerEngine, EngineEvent, EngineEventHandler, EngineMountOptions } from '../types';
import { EngineEmitter } from './engine';

// rrweb-player ships no usable types for this setup; treat the instance as a loose record.
type RrwebPlayerInstance = {
  play(): void;
  pause(): void;
  goto(ms: number, play?: boolean): void;
  setSpeed(s: number): void;
  toggleSkipInactive(): void;
  getMetaData(): { totalTime: number };
  addEventListener(ev: string, cb: (e: { payload?: unknown }) => void): void;
  $set(props: Record<string, unknown>): void;
  triggerResize(): void;
  $destroy(): void;
};

export class RrwebPlayerEngine implements PlayerEngine {
  private p: RrwebPlayerInstance | null = null;
  private emitter = new EngineEmitter();
  private screenEl!: HTMLElement;
  private recW = 1280;
  private recH = 720;
  private playing = false;
  private skip = true;
  private currentMs = 0;

  mount(screenEl: HTMLElement, events: eventWithTime[], opts: EngineMountOptions): void {
    this.screenEl = screenEl;
    this.skip = opts.skipInactive;
    const meta = events.find((e) => e.type === 4) as
      | { data?: { width?: number; height?: number } }
      | undefined;
    this.recW = meta?.data?.width || 1280;
    this.recH = meta?.data?.height || 720;
    const w = screenEl.clientWidth || this.recW;
    const h = Math.round((this.recH / this.recW) * w);

    this.p = new (rrwebPlayer as unknown as new (cfg: unknown) => RrwebPlayerInstance)({
      target: screenEl,
      props: {
        events,
        width: w,
        height: h,
        autoPlay: opts.autoPlay,
        showController: true,
        skipInactive: opts.skipInactive,
        speedOption: [1, 2, 4, 8],
        speed: opts.speed,
      },
    });

    this.p.addEventListener('ui-update-player-state', (e) => {
      this.playing = e.payload === 'playing';
      this.emitter.emit('state', this.playing ? 'playing' : 'paused');
    });
    this.p.addEventListener('ui-update-current-time', (e) => {
      this.currentMs = typeof e.payload === 'number' ? e.payload : 0;
      this.emitter.emit('time', this.currentMs);
    });
    this.p.addEventListener('finish', () => {
      this.playing = false;
      this.emitter.emit('finish');
    });
  }

  play(timeMs?: number): void {
    if (!this.p) return;
    if (timeMs != null) {
      this.p.goto(timeMs, true);
      this.currentMs = timeMs;
      return;
    }
    const total = this.getDuration();
    // restart from the beginning if play is pressed at the end (parity with engine B)
    if (total > 0 && this.currentMs >= total - 50) {
      this.p.goto(0, true);
      this.currentMs = 0;
    } else {
      this.p.play();
    }
  }

  pause(): void {
    this.p?.pause();
  }

  seek(timeMs: number): void {
    this.p?.goto(timeMs, this.playing);
    this.currentMs = timeMs;
  }

  setSpeed(speed: number): void {
    this.p?.setSpeed(speed);
  }

  setSkipInactive(on: boolean): void {
    if (on !== this.skip) {
      this.p?.toggleSkipInactive();
      this.skip = on;
    }
  }

  getDuration(): number {
    return this.p?.getMetaData().totalTime ?? 0;
  }

  getCurrentTime(): number {
    const total = this.getDuration();
    return total > 0 ? Math.max(0, Math.min(this.currentMs, total)) : Math.max(0, this.currentMs);
  }

  resize(width: number, maxHeight?: number): void {
    const scale = maxHeight
      ? Math.min(width / this.recW, maxHeight / this.recH)
      : width / this.recW;
    this.p?.$set({ width: Math.round(this.recW * scale), height: Math.round(this.recH * scale) });
    this.p?.triggerResize();
  }

  on(event: EngineEvent, handler: EngineEventHandler): void {
    this.emitter.on(event, handler);
  }

  destroy(): void {
    try {
      this.p?.$destroy();
    } catch {
      /* noop */
    }
    if (this.screenEl) this.screenEl.innerHTML = '';
    this.emitter.clear();
  }
}
