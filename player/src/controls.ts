import type { PlayerEngine } from './types';

export interface ControlsHost {
  toggleFullscreen(): void;
}

export interface ControlsHandle {
  el: HTMLElement;
  setFullscreenState(on: boolean): void;
  realign(): void;
  destroy(): void;
}

function fmtDur(ms: number): string {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

export function buildControls(
  engine: PlayerEngine,
  host: ControlsHost,
  opts: { speedOptions: number[]; skipInactive: boolean },
): ControlsHandle {
  const bar = document.createElement('div');
  bar.className = 'pc';
  const speedBtns = opts.speedOptions
    .map(
      (s, i) =>
        `<button type="button" data-speed="${s}" aria-pressed="${i === 0 ? 'true' : 'false'}"${i === 0 ? ' class="is-active"' : ''}>${s}×</button>`,
    )
    .join('');
  bar.innerHTML = `
    <div class="pc__scrub" role="slider" tabindex="0" aria-label="Перемотка" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <div class="pc__rail"><div class="pc__fill"></div><div class="pc__thumb"></div></div>
    </div>
    <div class="pc__row">
      <div class="pc__left">
        <button class="pc__play" type="button" data-state="paused" aria-label="Воспроизвести">
          <svg class="ic-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          <svg class="ic-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zm6.6 0H17v14h-3.4z"/></svg>
        </button>
        <div class="pc__time"><span class="pc__cur">0:00</span><span class="pc__sep">/</span><span class="pc__dur">0:00</span></div>
      </div>
      <div class="pc__right">
        <div class="pc__speeds"><span class="pc__ind"></span>${speedBtns}</div>
        <button class="pc__toggle" type="button" role="switch" aria-checked="${opts.skipInactive}">
          <span class="pc__track"><span class="pc__knob"></span></span>
          <span class="pc__toggle-label">Пропуск пауз</span>
        </button>
        <button class="pc__icon" type="button" data-fs="off" aria-label="На весь экран" title="На весь экран">
          <svg class="ic-expand" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm14 0h-2v3h-3v2h5v-5z"/></svg>
          <svg class="ic-compress" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
        </button>
      </div>
    </div>`;

  const $ = <T extends Element>(s: string): T => bar.querySelector(s) as T;
  const fill = $<HTMLElement>('.pc__fill');
  const thumb = $<HTMLElement>('.pc__thumb');
  const cur = $<HTMLElement>('.pc__cur');
  const dur = $<HTMLElement>('.pc__dur');
  const playBtn = $<HTMLElement>('.pc__play');
  const scrub = $<HTMLElement>('.pc__scrub');
  const rail = $<HTMLElement>('.pc__rail');
  const speedsEl = $<HTMLElement>('.pc__speeds');
  const ind = $<HTMLElement>('.pc__ind');
  const skipBtn = $<HTMLElement>('.pc__toggle');
  const fsBtn = $<HTMLElement>('.pc__icon');
  const speedButtons = Array.from(speedsEl.querySelectorAll('button'));

  let dragging = false;
  let playing = false;
  let skip = opts.skipInactive;
  let total = 0;
  let curMs = 0;

  const setTotal = (): void => {
    total = engine.getDuration();
    dur.textContent = fmtDur(total);
  };
  const setProgress = (ratio: number): void => {
    ratio = Math.max(0, Math.min(1, ratio));
    fill.style.width = thumb.style.left = (ratio * 100).toFixed(3) + '%';
    scrub.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };
  // Track the authoritative current time so keyboard seeking reads true ms
  // (not the rounded aria-valuenow percent) and screen readers announce it.
  const setCur = (ms: number): void => {
    curMs = Math.max(0, Math.min(total > 0 ? total : ms, ms));
    cur.textContent = fmtDur(curMs);
    scrub.setAttribute('aria-valuetext', fmtDur(curMs) + ' из ' + fmtDur(total));
  };
  const moveIndicator = (btn: HTMLElement): void => {
    ind.style.width = btn.offsetWidth + 'px';
    ind.style.transform = `translateX(${btn.offsetLeft - 3}px)`;
  };
  const realign = (): void => {
    const a = (speedsEl.querySelector('button.is-active') as HTMLElement) || speedButtons[0];
    if (a) moveIndicator(a);
  };
  const ratioFromEvent = (ev: PointerEvent): number => {
    const r = rail.getBoundingClientRect();
    return r.width ? (ev.clientX - r.left) / r.width : 0;
  };
  const seek = (ev: PointerEvent): void => {
    const ratio = Math.max(0, Math.min(1, ratioFromEvent(ev)));
    setProgress(ratio);
    setCur(ratio * total);
    engine.seek(ratio * total);
  };

  playBtn.addEventListener('click', () => (playing ? engine.pause() : engine.play()));
  scrub.addEventListener('pointerdown', (ev) => {
    dragging = true;
    bar.classList.add('is-scrubbing');
    try { scrub.setPointerCapture(ev.pointerId); } catch { /* noop */ }
    seek(ev);
  });
  scrub.addEventListener('pointermove', (ev) => { if (dragging) seek(ev); });
  const endDrag = (): void => { if (dragging) { dragging = false; bar.classList.remove('is-scrubbing'); } };
  scrub.addEventListener('pointerup', endDrag);
  scrub.addEventListener('pointercancel', endDrag);
  scrub.addEventListener('keydown', (ev) => {
    if (total <= 0) return;
    let next: number;
    if (ev.key === 'ArrowRight') next = Math.min(total, curMs + 5000);
    else if (ev.key === 'ArrowLeft') next = Math.max(0, curMs - 5000);
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = total;
    else return;
    ev.preventDefault();
    setProgress(next / total);
    setCur(next);
    engine.seek(next);
  });
  speedButtons.forEach((btn) =>
    btn.addEventListener('click', () => {
      engine.setSpeed(Number(btn.dataset.speed));
      speedButtons.forEach((b) => {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      moveIndicator(btn);
    }),
  );
  skipBtn.addEventListener('click', () => {
    skip = !skip;
    engine.setSkipInactive(skip);
    skipBtn.setAttribute('aria-checked', String(skip));
  });
  fsBtn.addEventListener('click', () => host.toggleFullscreen());

  engine.on('state', (p) => {
    playing = p === 'playing';
    playBtn.dataset.state = playing ? 'playing' : 'paused';
    playBtn.setAttribute('aria-label', playing ? 'Пауза' : 'Воспроизвести');
  });
  engine.on('time', (ms) => {
    const t = typeof ms === 'number' ? ms : 0;
    setCur(t);
    if (!dragging && total > 0) setProgress(t / total);
  });
  engine.on('finish', () => {
    playing = false;
    playBtn.dataset.state = 'paused';
  });

  setTotal();
  setProgress(0);
  setCur(0);
  realign();
  requestAnimationFrame(realign);

  return {
    el: bar,
    setFullscreenState(on: boolean) {
      fsBtn.dataset.fs = on ? 'on' : 'off';
      fsBtn.setAttribute('aria-label', on ? 'Свернуть' : 'На весь экран');
      requestAnimationFrame(realign);
    },
    realign,
    destroy() {
      bar.remove();
    },
  };
}
