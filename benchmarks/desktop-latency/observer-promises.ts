/** Retain rejection custody while an input dispatch is still in flight.
 * The caller receives the original rejecting promise and must await it. */
export function holdObservation<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}
