// The SDK ships JSDoc that the TypeScript checker cannot parse, so it is
// treated as untyped. Our own types for its data live in src/types.js.
declare module '@unitn-asa/deliveroo-js-sdk/client';

// The installed planning client exposes onlineSolver(domain, problem).
declare module '@unitn-asa/pddl-client' {
  export function onlineSolver(domain: string, problem: string): Promise<unknown>;
}
