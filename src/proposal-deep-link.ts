/**
 * Deep link to one proposal: `#proposal/<base58>`.
 *
 * HASH, NOT PATH, DELIBERATELY. A path like `/proposal/<addr>` needs a server
 * rewrite so a refresh does not 404. That would add an infrastructure
 * requirement to a UI whose whole continuity story is "clone the repo and host
 * it anywhere static" - see the Succession panel. A hash survives any static
 * host, including someone else's, with no config at all.
 */
export const PROPOSAL_HASH_PREFIX = "#proposal/";

export function proposalHashFor(address: string): string {
  return `${PROPOSAL_HASH_PREFIX}${address}`;
}

/**
 * The proposal address in a URL hash, or null.
 *
 * Shape-checked, never trusted. A malformed value must not reach a chain read
 * dressed as an address; a well-formed address that does not exist is the
 * detail panel's error to surface, not this function's.
 */
export function proposalFromHash(hash: string): string | null {
  if (!hash.startsWith(PROPOSAL_HASH_PREFIX)) {
    return null;
  }
  const candidate = hash.slice(PROPOSAL_HASH_PREFIX.length).trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate) ? candidate : null;
}
