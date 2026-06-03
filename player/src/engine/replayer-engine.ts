import { Replayer, EventType, ReplayerEvents } from 'rrweb';
import type { eventWithTime } from '@rrweb/types';
import type { PlayerEngine, EngineEvent, EngineEventHandler, EngineMountOptions } from '../types';
import { EngineEmitter } from './engine';

export class ReplayerEngine implements PlayerEngine {
  private replayer: Replayer | null = null;
  private emitter = new EngineEmitter();
  private screenEl!: HTMLElement;
  private wrapper: HTMLElement | null = null;
  private recW = 1280;
  private recH = 720;
  private playing = false;
  private raf = 0;

  mount(screenEl: HTMLElement, events: eventWithTime[], opts: EngineMountOptions): void {
    this.screenEl = screenEl;
    const meta = events.find((e) => e.type === EventType.Meta) as
      | { data?: { width?: number; height?: number } }
      | undefined;
    this.recW = meta?.data?.width || 1280;
    this.recH = meta?.data?.height || 720;

    this.replayer = new Replayer(events, {
      root: screenEl,
      speed: opts.speed,
      skipInactive: opts.skipInactive,
      showWarning: false,
      mouseTail: false,
    });
    this.wrapper = screenEl.querySelector('.replayer-wrapper');

    this.replayer.on(ReplayerEvents.Start, () => this.setPlaying(true));
    this.replayer.on(ReplayerEvents.Resume, () => this.setPlaying(true));
    this.replayer.on(ReplayerEvents.Pause, () => this.setPlaying(false));
    this.replayer.on(ReplayerEvents.Finish, () => {
      this.setPlaying(false);
      this.emitter.emit('finish');
    });

    this.resize(screenEl.clientWidth || this.recW);
    if (opts.autoPlay) this.play(0);
    else this.replayer.pause(0);
  }

  private setPlaying(p: boolean): void {
    this.playing = p;
    this.emitter.emit('state', p ? 'playing' : 'paused');
    if (p) this.startRaf();
    else this.stopRaf();
  }

  private startRaf(): void {
    cancelAnimationFrame(this.raf);
    const tick = (): void => {
      if (!this.replayer) return;
      const total = this.getDuration();
      const t = this.replayer.getCurrentTime();
      // rrweb's getCurrentTime keeps growing with wall-clock past the end; clamp + auto-finish.
      if (total > 0 && t >= total) {
        this.emitter.emit('time', total);
        this.setPlaying(false);
        this.emitter.emit('finish');
        return;
      }
      this.emitter.emit('time', t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    cancelAnimationFrame(this.raf);
  }

  play(timeMs?: number): void {
    if (!this.replayer) return;
    let t = timeMs ?? this.getCurrentTime();
    const total = this.getDuration();
    // if play is pressed at (or past) the end, restart from the beginning
    if (timeMs == null && total > 0 && t >= total - 50) t = 0;
    this.replayer.play(t);
  }

  pause(): void {
    this.replayer?.pause();
  }

  seek(timeMs: number): void {
    if (!this.replayer) return;
    if (this.playing) this.replayer.play(timeMs);
    else {
      this.replayer.pause(timeMs);
      this.emitter.emit('time', timeMs);
    }
  }

  setSpeed(speed: number): void {
    this.replayer?.setConfig({ speed });
  }

  setSkipInactive(on: boolean): void {
    this.replayer?.setConfig({ skipInactive: on });
  }

  getDuration(): number {
    return this.replayer?.getMetaData().totalTime ?? 0;
  }

  getCurrentTime(): number {
    const t = this.replayer?.getCurrentTime() ?? 0;
    const total = this.getDuration();
    return total > 0 ? Math.max(0, Math.min(t, total)) : Math.max(0, t);
  }

  resize(width: number, maxHeight?: number): void {
    if (!this.wrapper) return;
    const scale = maxHeight
      ? Math.min(width / this.recW, maxHeight / this.recH)
      : width / this.recW;
    this.wrapper.style.transform = `scale(${scale})`;
    this.screenEl.style.width = `${Math.round(this.recW * scale)}px`;
    this.screenEl.style.height = `${Math.round(this.recH * scale)}px`;
  }

  on(event: EngineEvent, handler: EngineEventHandler): void {
    this.emitter.on(event, handler);
  }

  destroy(): void {
    this.stopRaf();
    this.replayer?.pause();
    this.replayer?.destroy();
    this.screenEl.innerHTML = '';
  }
}
