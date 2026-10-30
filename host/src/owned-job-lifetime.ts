export interface OwnedJobLifetime {
  readonly closed: boolean;
}

export function createOwnedJobLifetime(initiallyClosed = false) {
  let closed = initiallyClosed;
  return {
    token: Object.freeze({ get closed() { return closed; } }),
    close: () => { closed = true; },
  };
}
