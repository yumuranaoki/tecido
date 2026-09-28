/** Transactional storage required by the durable runtime host. */
export interface RuntimeStorageTransaction {
  get<Value>(key: string): Promise<Value | undefined>;
  put<Value>(key: string, value: Value): Promise<void>;
  delete?(key: string): Promise<void>;
  setAlarm(time: number): Promise<void>;
  getAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
}

/** Per-object storage supplied by a durable runtime host. */
export interface RuntimeStorage extends RuntimeStorageTransaction {
  transaction<Value>(operation: (transaction: RuntimeStorageTransaction) => Promise<Value>): Promise<Value>;
}

/** State supplied when constructing one durable runtime object. */
export interface RuntimeObjectState {
  readonly storage: RuntimeStorage;
}

/** Namespace used to address durable runtime objects by stable name. */
export interface RuntimeObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
