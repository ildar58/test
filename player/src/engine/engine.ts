import type { EngineEvent, EngineEventHandler } from '../types';

export type {
  PlayerEngine,
  EngineEvent,
  EngineEventHandler,
  EngineMountOptions,
} from '../types';

/** Minimal typed event emitter shared by both engines. */
export class EngineEmitter {
  private handlers: Partial<Record<EngineEvent, EngineEventHandler[]>> = {};

  on(event: EngineEvent, handler: EngineEventHandler): void {
    (this.handlers[event] ||= []).push(handler);
  }

  emit(event: EngineEvent, payload?: number | string): void {
    (this.handlers[event] || []).forEach((h) => h(payload));
  }

  clear(): void {
    this.handlers = {};
  }
}
