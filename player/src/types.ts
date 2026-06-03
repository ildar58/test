import type { eventWithTime } from '@rrweb/types';

export type ThemeName = 'dark' | 'light';

export interface ThemeTokens {
  accent?: string;
  accentStrong?: string;
  onAccent?: string;
  bg?: string;
  surface?: string;
  surface2?: string;
  inset?: string;
  text?: string;
  text2?: string;
  text3?: string;
  line?: string;
  line2?: string;
  radius?: string;
  radiusSm?: string;
  font?: string;
  mono?: string;
}

export type ThemeInput = ThemeName | (ThemeTokens & { preset?: ThemeName });

export type EngineName = 'replayer' | 'rrweb-player';

export interface PamPlayerOptions {
  events: eventWithTime[];
  engine?: EngineName;
  theme?: ThemeInput;
  autoPlay?: boolean;
  skipInactive?: boolean;
  speed?: number;
  speedOptions?: number[];
  isolate?: boolean;
}

export type PamEvent = 'play' | 'pause' | 'time' | 'finish' | 'fullscreenchange';
export type PamEventHandler = (payload?: number | string) => void;

export interface PamPlayer {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(timeMs: number): void;
  setSpeed(speed: number): void;
  setSkipInactive(on: boolean): void;
  setTheme(theme: ThemeInput): void;
  toggleFullscreen(): void;
  getDuration(): number;
  getCurrentTime(): number;
  on(event: PamEvent, handler: PamEventHandler): () => void;
  destroy(): void;
}

export type EngineEvent = 'state' | 'time' | 'finish';
export type EngineEventHandler = (payload?: number | string) => void;

export interface EngineMountOptions {
  speed: number;
  skipInactive: boolean;
  autoPlay: boolean;
}

export interface PlayerEngine {
  mount(screenEl: HTMLElement, events: eventWithTime[], opts: EngineMountOptions): void | Promise<void>;
  play(timeMs?: number): void;
  pause(): void;
  seek(timeMs: number): void;
  setSpeed(speed: number): void;
  setSkipInactive(on: boolean): void;
  getDuration(): number;
  getCurrentTime(): number;
  /** Fit content to `width`; if `maxHeight` given, contain within it (used in fullscreen). */
  resize(width: number, maxHeight?: number): void;
  on(event: EngineEvent, handler: EngineEventHandler): void;
  destroy(): void;
}
