// Control-bar + screen CSS, tokenized to var(--pam-*). Injected into the (shadow) root.
export const CONTROL_CSS = `
:host { display: block; }

.pam-block {
  position: relative;
  border-radius: var(--pam-radius);
  overflow: hidden;
  border: 1px solid var(--pam-line);
  background: var(--pam-surface);
  box-shadow: 0 26px 60px -26px rgba(0,0,0,0.72), 0 0 56px -30px color-mix(in srgb, var(--pam-accent) 16%, transparent);
  font-family: var(--pam-font);
  color: var(--pam-text);
}

.pam-screen { position: relative; overflow: hidden; background: #fff; }
.pam-screen .replayer-wrapper { float: none; }
.pam-screen .rr-player { border-radius: 0 !important; box-shadow: none !important; height: auto !important; margin: 0 !important; float: none !important; background: #fff !important; }
.pam-screen .rr-player__frame { overflow: hidden; }
.pam-screen .rr-controller { display: none !important; }

.pam-loading { padding: 44px 20px; text-align: center; color: var(--pam-text-2); font-family: var(--pam-font); font-size: 14px; }

.pc {
  width: 100%;
  background: linear-gradient(180deg, var(--pam-surface-2), var(--pam-surface));
  padding: 14px 16px 15px;
  display: flex; flex-direction: column; gap: 13px;
  animation: pam-reveal 0.45s cubic-bezier(0.2,0.7,0.2,1) both;
}
@keyframes pam-reveal { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

.pc__scrub { padding: 7px 0 3px; cursor: pointer; touch-action: none; }
.pc__scrub:focus-visible { outline: none; }
.pc__scrub:focus-visible .pc__rail { box-shadow: 0 0 0 3px color-mix(in srgb, var(--pam-accent) 25%, transparent); }
.pc__rail { position: relative; height: 6px; border-radius: 99px; background: var(--pam-line-2); transition: box-shadow 0.18s cubic-bezier(0.2,0.7,0.2,1); }
.pc__fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; border-radius: 99px; background: linear-gradient(90deg, var(--pam-accent-strong), var(--pam-accent)); box-shadow: 0 0 12px color-mix(in srgb, var(--pam-accent) 45%, transparent); }
.pc__thumb { position: absolute; top: 50%; left: 0; width: 14px; height: 14px; border-radius: 50%; background: var(--pam-accent); transform: translate(-50%, -50%) scale(0.6); box-shadow: 0 0 0 4px color-mix(in srgb, var(--pam-accent) 16%, transparent), 0 2px 6px rgba(0,0,0,0.5); transition: transform 0.16s cubic-bezier(0.2,0.7,0.2,1); pointer-events: none; }
.pc__scrub:hover .pc__thumb, .pc.is-scrubbing .pc__thumb { transform: translate(-50%, -50%) scale(1); }

.pc__row { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.pc__left { display: flex; align-items: center; gap: 14px; }
.pc__right { display: flex; align-items: center; gap: 11px; }

.pc__play {
  flex-shrink: 0; width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  background: radial-gradient(120% 120% at 30% 22%, color-mix(in srgb, var(--pam-accent) 78%, #fff), var(--pam-accent) 55%, var(--pam-accent-strong));
  display: grid; place-items: center;
  box-shadow: 0 8px 22px -6px color-mix(in srgb, var(--pam-accent) 50%, transparent), inset 0 1px 0 rgba(255,255,255,0.5);
  transition: transform 0.14s cubic-bezier(0.2,0.7,0.2,1), box-shadow 0.2s cubic-bezier(0.2,0.7,0.2,1);
}
.pc__play:hover { box-shadow: 0 12px 28px -6px color-mix(in srgb, var(--pam-accent) 66%, transparent), inset 0 1px 0 rgba(255,255,255,0.5); }
.pc__play:active { transform: scale(0.9); }
.pc__play svg { width: 22px; height: 22px; fill: var(--pam-on-accent); display: none; }
.pc__play[data-state="paused"] .ic-play { display: block; margin-left: 2px; }
.pc__play[data-state="playing"] .ic-pause { display: block; }

.pc__time { font-family: var(--pam-mono); font-size: 14px; font-weight: 500; white-space: nowrap; }
.pc__cur { color: var(--pam-text); font-weight: 600; }
.pc__sep { color: var(--pam-text-3); margin: 0 5px; }
.pc__dur { color: var(--pam-text-3); }

.pc__speeds { position: relative; display: flex; align-items: center; background: var(--pam-inset); border: 1px solid var(--pam-line); border-radius: 11px; padding: 3px; }
.pc__ind { position: absolute; top: 3px; bottom: 3px; left: 3px; width: 0; border-radius: 8px; background: var(--pam-accent); box-shadow: 0 2px 8px -2px color-mix(in srgb, var(--pam-accent) 55%, transparent); transition: transform 0.22s cubic-bezier(0.2,0.7,0.2,1), width 0.22s cubic-bezier(0.2,0.7,0.2,1); }
.pc__speeds button { position: relative; z-index: 1; border: none; background: transparent; cursor: pointer; font-family: var(--pam-mono); font-size: 12.5px; font-weight: 600; color: var(--pam-text-3); padding: 6px 11px; border-radius: 8px; transition: color 0.18s cubic-bezier(0.2,0.7,0.2,1); }
.pc__speeds button.is-active { color: var(--pam-on-accent); }
.pc__speeds button:not(.is-active):hover { color: var(--pam-text); }

.pc__toggle { display: inline-flex; align-items: center; gap: 9px; border: none; background: transparent; cursor: pointer; padding: 6px 2px; color: var(--pam-text-2); font-family: var(--pam-font); font-size: 13px; font-weight: 500; transition: color 0.18s cubic-bezier(0.2,0.7,0.2,1); }
.pc__track { position: relative; flex-shrink: 0; width: 38px; height: 22px; border-radius: 99px; background: var(--pam-line-2); transition: background 0.2s cubic-bezier(0.2,0.7,0.2,1); }
.pc__knob { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.4); transition: transform 0.2s cubic-bezier(0.2,0.7,0.2,1), background 0.2s cubic-bezier(0.2,0.7,0.2,1); }
.pc__toggle[aria-checked="true"] { color: var(--pam-text); }
.pc__toggle[aria-checked="true"] .pc__track { background: var(--pam-accent); }
.pc__toggle[aria-checked="true"] .pc__knob { transform: translateX(16px); background: var(--pam-on-accent); }

.pc__icon { flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px; border: 1px solid var(--pam-line); background: var(--pam-inset); cursor: pointer; display: grid; place-items: center; color: var(--pam-text-2); transition: color 0.16s cubic-bezier(0.2,0.7,0.2,1), border-color 0.16s cubic-bezier(0.2,0.7,0.2,1), background 0.16s cubic-bezier(0.2,0.7,0.2,1), transform 0.14s cubic-bezier(0.2,0.7,0.2,1); }
.pc__icon svg { width: 17px; height: 17px; fill: currentColor; }
.pc__icon:hover { color: var(--pam-accent); border-color: var(--pam-line-2); background: var(--pam-surface-2); }
.pc__icon:active { transform: scale(0.92); }
.pc__icon .ic-compress { display: none; }
.pc__icon[data-fs="on"] .ic-expand { display: none; }
.pc__icon[data-fs="on"] .ic-compress { display: block; }

@media (max-width: 560px) {
  .pc__left { flex: 1 1 auto; }
  .pc__right { flex: 1 1 100%; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
}

.pam-block:fullscreen { width: 100vw !important; height: 100vh !important; border-radius: 0 !important; border: none !important; background: var(--pam-bg) !important; display: flex; flex-direction: column; }
.pam-block:fullscreen .pam-screen { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; background: var(--pam-bg) !important; }
.pam-block:fullscreen .pc { flex: 0 0 auto; border-top: 1px solid var(--pam-line); }

@media (prefers-reduced-motion: reduce) {
  .pc, .pc__thumb, .pc__ind, .pc__knob, .pc__play, .pc__icon { animation: none !important; transition: none !important; }
}
`;

// rrweb Replayer primitives (wrapper + mouse cursor + click ripple). Injected for engine B.
export const REPLAYER_CSS = `
.replayer-wrapper { position: absolute; transform-origin: top left; left: 50%; top: 50%; }
.replayer-wrapper > iframe { border: none; }
.replayer-mouse {
  position: absolute; width: 20px; height: 20px;
  transition: left 0.05s linear, top 0.05s linear;
  background-size: contain; background-position: center center; background-repeat: no-repeat;
  background-image: url('data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9JzMwMHB4JyB3aWR0aD0nMzAwcHgnICBmaWxsPSIjMDAwMDAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGRhdGEtbmFtZT0iTGF5ZXIgMSIgdmlld0JveD0iMCAwIDUwIDUwIiB4PSIwcHgiIHk9IjBweCI+PHRpdGxlPkRlc2lnbl90bnA8L3RpdGxlPjxwYXRoIGQ9Ik00OC43MSw0Mi45MUwzNC4wOCwyOC4yOSw0NC4zMywxOEExLDEsMCwwLDAsNDQsMTYuMzlMMi4zNSwxLjA2QTEsMSwwLDAsMCwxLjA2LDIuMzVMMTYuMzksNDRhMSwxLDAsMCwwLDEuNjUuMzZMMjguMjksMzQuMDgsNDIuOTEsNDguNzFhMSwxLDAsMCwwLDEuNDEsMGw0LjM4LTQuMzhBMSwxLDAsMCwwLDQ4LjcxLDQyLjkxWm0tNS4wOSwzLjY3TDI5LDMyYTEsMSwwLDAsMC0xLjQxLDBsLTkuODUsOS44NUwzLjY5LDMuNjlsMzguMTIsMTRMMzIsMjcuNThBMSwxLDAsMCwwLDMyLDI5TDQ2LjU5LDQzLjYyWiI+PC9wYXRoPjwvc3ZnPg==');
  border-color: transparent;
}
.replayer-mouse::after { content: ''; display: inline-block; width: 20px; height: 20px; background: rgb(73,80,246); border-radius: 100%; transform: translate(-50%, -50%); opacity: 0.3; }
.replayer-mouse.active::after { animation: pam-click 0.2s ease-in-out 1; }
@keyframes pam-click { 0% { opacity: 0.3; width: 20px; height: 20px; } 50% { opacity: 1; width: 10px; height: 10px; } }
`;
