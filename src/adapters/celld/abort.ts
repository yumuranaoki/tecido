/** Stop awaiting uncooperative external code without claiming its side effect stopped. */
export async function awaitWithSignal<Value>(operation: () => Promise<Value>, signal: AbortSignal): Promise<Value> {
  signal.throwIfAborted();

  let listener: () => void = () => {};

  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });

  try {
    return await Promise.race([operation(), aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
