// vitest stub: unit tests never open TLS sockets. The real module exists only in the Workers runtime.
export function connect(): never { throw new Error('cloudflare:sockets is not available in unit tests') }
