/**
 * Concurrent map that keeps result order and caps in-flight work. The tsrs async client
 * folds every request issued in one tick into a single batchRequests, so a bounded fan-out
 * costs about `items / limit` round trips where an await-in-a-loop costs `items`.
 */
export const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await operation(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Default fan-out for per-file and per-node checker work. */
export const FAN_OUT = 256
