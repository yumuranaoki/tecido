/** Celld adapter contracts, verified against celld 0.5.1. */
export interface StorageTransaction {
  get<Value>(key: string): Promise<Value | undefined>;
  put<Value>(key: string, value: Value): Promise<void>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

export interface CellStorage extends StorageTransaction {
  transaction<Value>(operation: (transaction: StorageTransaction) => Promise<Value>): Promise<Value>;
}

export interface CellState {
  readonly storage: CellStorage;
}

export interface CellNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface HostEnv {
  readonly TECIDO_THREADS: CellNamespace;
  readonly TECIDO_SCHEDULES: CellNamespace;
  readonly [name: string]: unknown;
}
