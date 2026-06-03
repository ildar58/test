// тело запроса POST /s/; user_id не передаётся, сервер берёт из куки
export interface EventBatch {
  /** UUID от рекордера */
  session_id: string;
  /** монотонный счётчик батчей в сессии */
  batch_seq: number;
  /** base64(gzip(JSON.stringify(eventWithTime[]))) */
  events_b64_gzip: string;
}

export interface SessionMeta {
  session_id: string;
  /** берётся из куки при первом батче */
  user_id: string;
  started_at: string;
  last_batch_at: string;
  batch_count: number;
}
