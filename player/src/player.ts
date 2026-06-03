import type {
  PamPlayer,
  PamPlayerOptions,
  PamEvent,
  PamEventHandler,
  ThemeInput,
  PlayerEngine,
} from './types';
import { applyTheme } from './theme';
import { CONTROL_CSS, REPLAYER_CSS } from './styles';
import { ReplayerEngine } from './engine/replayer-engine';
import { buildControls, type ControlsHandle } from './controls';

export function createPamPlayer(target: HTMLElement, options: PamPlayerOptions): PamPlayer {
  const opts = {
    engine: 'replayer' as const,
    theme: 'dark' as ThemeInput,
    autoPlay: false,
    skipInactive: true,
    speed: 1,
    speedOptions: [1, 2, 4, 8],
    isolate: true,
    ...options,
  };

  const host = document.createElement('div');
  host.className = 'pam-player';
  target.appendChild(host);
  applyTheme(host, opts.theme);

  const root: HTMLElement | ShadowRoot = opts.isolate ? host.attachShadow({ mode: 'open' }) : host;
  const style = document.createElement('style');
  style.textContent = CONTROL_CSS + REPLAYER_CSS;
  root.appendChild(style);

  const block = document.createElement('div');
  block.className = 'pam-block';
  const screen = document.createElement('div');
  screen.className = 'pam-screen';
  block.appendChild(screen);
  root.appendChild(block);

  const listeners: Partial<Record<PamEvent, PamEventHandler[]>> = {};
  const emit = (ev: PamEvent, payload?: number | string): void =>
    (listeners[ev] || []).forEach((h) => h(payload));

  let engine: PlayerEngine = new ReplayerEngine();
  let controls: ControlsHandle | null = null;
  let ready = false;
  let destroyed = false;

  function toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      const p = block.requestFullscreen?.();
      if (p && p.catch) p.catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  }
  function onFsChange(): void {
    if (!ready) return;
    // In Shadow DOM, document.fullscreenElement reports the host, not the inner block.
    const fs = document.fullscreenElement === block || document.fullscreenElement === host;
    controls?.setFullscreenState(fs);
    if (fs) engine.resize(window.innerWidth, window.innerHeight - (controls?.el.offsetHeight || 112));
    else engine.resize(block.clientWidth);
    emit('fullscreenchange', fs ? 'on' : 'off');
  }
  document.addEventListener('fullscreenchange', onFsChange);

  const ro = new ResizeObserver(() => {
    if (ready && !document.fullscreenElement) engine.resize(block.clientWidth);
  });
  ro.observe(block);

  function wireEngine(): void {
    controls = buildControls(
      engine,
      { toggleFullscreen },
      { speedOptions: opts.speedOptions, skipInactive: opts.skipInactive },
    );
    block.appendChild(controls.el);
    engine.on('state', (p) => emit(p === 'playing' ? 'play' : 'pause'));
    engine.on('time', (ms) => emit('time', ms));
    engine.on('finish', () => emit('finish'));
    engine.resize(block.clientWidth);
    ready = true;
  }

  const mountOpts = { speed: opts.speed, skipInactive: opts.skipInactive, autoPlay: opts.autoPlay };

  if (opts.engine === 'rrweb-player') {
    screen.innerHTML = '<div class="pam-loading">Загрузка движка…</div>';
    void import('./engine/rrweb-player-engine').then(async ({ RrwebPlayerEngine }) => {
      if (destroyed) return;
      engine = new RrwebPlayerEngine();
      screen.innerHTML = '';
      await engine.mount(screen, opts.events, mountOpts);
      if (destroyed) {
        engine.destroy();
        return;
      }
      wireEngine();
    });
  } else {
    engine.mount(screen, opts.events, mountOpts);
    wireEngine();
  }

  return {
    play: () => engine.play(),
    pause: () => engine.pause(),
    toggle: () => controls?.el.querySelector<HTMLElement>('.pc__play')?.click(),
    seek: (ms) => engine.seek(ms),
    setSpeed: (s) => engine.setSpeed(s),
    setSkipInactive: (b) => engine.setSkipInactive(b),
    setTheme: (t) => applyTheme(host, t),
    toggleFullscreen,
    getDuration: () => engine.getDuration(),
    getCurrentTime: () => engine.getCurrentTime(),
    on(ev, h) {
      (listeners[ev] ||= []).push(h);
      return () => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== h); };
    },
    destroy() {
      destroyed = true;
      ro.disconnect();
      document.removeEventListener('fullscreenchange', onFsChange);
      controls?.destroy();
      engine.destroy();
      for (const k in listeners) delete listeners[k as PamEvent];
      host.remove();
    },
  };
}
