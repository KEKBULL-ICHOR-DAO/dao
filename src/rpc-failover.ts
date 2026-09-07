/**
 * Browser JSON-RPC transport: try the bound Connection endpoint, then the
 * official cluster HTTP RPC. The keyed provider URL never enters this file.
 */

export function jsonRpcLooksRateLimited(bodyText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.some((row) => {
      if (row === null || typeof row !== "object") {
        return false;
      }
      const code = (row as { error?: { code?: unknown } }).error?.code;
      return code === -32005 || code === -32429;
    });
  } catch {
    return false;
  }
}

export function shouldFailoverHttpStatus(status: number): boolean {
  return (
    status === 404 ||
    status === 405 ||
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export function shouldFailoverResponse(status: number, bodyText: string): boolean {
  return shouldFailoverHttpStatus(status) || jsonRpcLooksRateLimited(bodyText);
}

export function createOfficialFallbackFetch(params: {
  fallbackUrl: string;
  fetchImpl?: typeof fetch;
}): typeof fetch {
  const fetchImpl = params.fetchImpl ?? fetch;
  const fallbackUrl = params.fallbackUrl;
  return async (input, init) => {
    try {
      const res = await fetchImpl(input, init);
      const bodyText = await res.text();
      if (!shouldFailoverResponse(res.status, bodyText)) {
        return new Response(bodyText, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    } catch {
      /* primary unreachable - official cluster is the documented fallback */
    }
    return fetchImpl(fallbackUrl, init);
  };
}
