import { record } from 'rrweb';
import type { eventWithTime, listenerHandler } from '@rrweb/types';
import type { RecorderConfig } from './config';
import { Transport } from './transport';

export class Recorder {
  private stopFn: listenerHandler | null = null;
  private transport: Transport;

  constructor(
    private readonly config: RecorderConfig,
    private readonly sessionId: string,
    private readonly distinctId: string
  ) {
    this.transport = new Transport(
      config.endpoint,
      config.flushIntervalMs,
      config.maxBufferSize
    );
  }

  start(): void {
    this.transport.start(this.sessionId, this.distinctId);

    this.stopFn = record({
      blockClass: this.config.blockClass,
      ignoreClass: this.config.ignoreClass,
      maskTextClass: this.config.maskTextClass,
      maskAllInputs: this.config.maskAllInputs,
      maskInputOptions: this.config.maskInputOptions,
      inlineStylesheet: this.config.inlineStylesheet,
      collectFonts: this.config.collectFonts,
      recordCrossOriginIframes: this.config.recordCrossOriginIframes,
      checkoutEveryNms: this.config.checkoutEveryNms,
      emit: (event: eventWithTime) => {
        this.transport.push(event, this.sessionId, this.distinctId);
      },
    }) ?? null;
  }

  addCustomEvent(tag: string, payload: Record<string, unknown>): void {
    record.addCustomEvent(tag, payload);
  }

  stop(): void {
    this.transport.flush(this.sessionId, this.distinctId);
    this.transport.stop();
    if (this.stopFn) {
      this.stopFn();
      this.stopFn = null;
    }
  }
}
