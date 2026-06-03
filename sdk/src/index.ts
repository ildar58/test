// Публичный API рекордера. Остаётся IDLE пока не появится маркер-кука,
// затем читает session_id из куки (выставленной сервером) и начинает запись.

import { DEFAULT_CONFIG, type RecorderConfig } from './config';
import { Recorder } from './recorder';
import { parseDatasetConfig } from './script-config';

export type { RecorderConfig };

export interface InitOptions extends Partial<RecorderConfig> {}

let instance: Recorder | null = null;

export function init(options: InitOptions = {}): void {
  if (instance) return;
  const config: RecorderConfig = { ...DEFAULT_CONFIG, ...options };
  instance = new Recorder(config);
  instance.start();
}

export function stop(): void {
  instance?.stop();
  instance = null;
}

/** Инициализация из data-* атрибутов тега script; при null ничего не делает (тесты, ESM). */
export function autoInit(script: HTMLScriptElement | null): void {
  if (script) init(parseDatasetConfig(script.dataset));
}

// При синхронной загрузке как <script> currentScript указывает на наш тег.
// При ESM-импорте и в тестах currentScript == null, ничего не происходит.
if (typeof document !== 'undefined') {
  autoInit(document.currentScript as HTMLScriptElement | null);
}
