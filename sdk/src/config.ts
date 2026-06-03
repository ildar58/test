export interface RecorderConfig {
  /** Куда слать батчи (абсолютный или корневой путь) */
  endpoint: string;

  /** CSS-класс: блокирует захват элемента и потомков */
  blockClass: string;

  /** CSS-класс: игнорировать input-события */
  ignoreClass: string;

  /** CSS-класс: маскировать текст */
  maskTextClass: string;

  /** Маскировать все input-значения звёздочками */
  maskAllInputs: boolean;

  /** Маски по типу поля */
  maskInputOptions: { password: boolean; [key: string]: boolean };

  /** Инлайнить стили в снапшот */
  inlineStylesheet: boolean;

  /** Скачивать и инлайнить шрифты */
  collectFonts: boolean;

  /** Записывать кросс-орижин iframe-ы */
  recordCrossOriginIframes: boolean;

  /** Полный снапшот DOM каждые N мс */
  checkoutEveryNms: number;

  /** Интервал сброса буфера на сервер (мс) */
  flushIntervalMs: number;

  /** Максимум событий в буфере до принудительного сброса */
  maxBufferSize: number;

  /** JS-доступная кука-маркер, выставляемая бэкендом при логине */
  markerCookieName: string;

  /** JS-доступная кука с id записывающей сессии */
  sessionIdCookieName: string;

  /** Интервал поллинга маркер-куки (мс) */
  markerPollMs: number;

  /** Число 401-ответов подряд до входа в cooldown */
  unauthorizedThreshold: number;

  /** Длительность cooldown (мс) */
  unauthorizedCooldownMs: number;
}

const MINUTE_MS = 60_000;

export const DEFAULT_CONFIG: RecorderConfig = {
  endpoint: '/s/',
  blockClass: 'rec-no-capture',
  ignoreClass: 'rec-ignore-input',
  maskTextClass: 'rec-mask',
  // maskAllInputs:true маскирует и <select>/<checkbox>, при воспроизведении
  // значение "*****" не совпадает ни с одним <option> и выбор теряется.
  // Маскируем только поля с паролем; блок логина обёрнут в rec-no-capture.
  maskAllInputs: false,
  maskInputOptions: { password: true },
  inlineStylesheet: true,
  collectFonts: false,
  recordCrossOriginIframes: false,
  checkoutEveryNms: 30 * MINUTE_MS,
  flushIntervalMs: 2_000,
  maxBufferSize: 500,
  markerCookieName: 'session_present',
  sessionIdCookieName: 'session_id',
  markerPollMs: 1_000,
  unauthorizedThreshold: 3,
  unauthorizedCooldownMs: MINUTE_MS,
};
