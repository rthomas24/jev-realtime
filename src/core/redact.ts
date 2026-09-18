/**
 * Strip credentials out of any text that outlives the moment.
 *
 * Intel MCP servers authenticate in the URL and in headers —
 * `mcp.alphavantage.co/mcp?apikey=…` and `Authorization: Bearer …`
 * (`shared/mcps.ts`, applied in `core/intel/servers.ts`). A fetch failure
 * against one of those carries the request URL in its `cause`, which is
 * exactly what `describeError` was written to surface. So the change that made
 * tool failures legible also made it possible for the operator's Alpha Vantage
 * key to reach the model as tool-result text — and from there into a stored
 * message, the tick log and the screen.
 *
 * It lives in `core/` rather than in the vendor layer because it stopped being
 * only about the model. The credential sweep persists a broker refresh failure
 * as `credentials.last_error` and writes the same string to Cloud Logging, and
 * that string is a THIRD-PARTY response body we do not control. The owner
 * seeing their own token echoed back is survivable; the same text sitting in
 * project logs is a wider audience than the person it belongs to.
 *
 * Redaction is by PARAMETER NAME and by scheme, not by entropy. Guessing at
 * "this looks like a secret" would mangle ticker lists and order ids, and
 * over-redaction destroys the debuggability this exists alongside. The list is
 * short because the ways we actually authenticate are short.
 */
export function redactSecrets(text: string): string {
  return text
    // ?apikey=… / &refresh_token=… / client_secret=… in a URL, a form body or
    // a log line. The optional prefix must end in a separator, so `refresh_`,
    // `access-` and `client.` all qualify while `monkey=` does not match `key`.
    .replace(/([?&](?:[\w.-]*[_.-])?(?:api[-_]?key|key|token|secret|password|pwd|sig|signature)=)[^&\s"'<>]+/gi, '$1[redacted]')
    // The same names as JSON keys — a broker echoing our form body back inside
    // an OAuth error is exactly the case this exists for.
    .replace(/("(?:[\w.-]*[_.-])?(?:api[-_]?key|key|token|secret|password)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    // Authorization: Bearer … / Basic …
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    // Anything that announces itself as one of ours.
    .replace(/\b(sk|rk|wk|ck)_[A-Za-z0-9_-]{8,}/g, '$1_[redacted]')
    // user:password@host in a connection string or proxied URL.
    .replace(/\/\/[^/\s:@]+:[^/\s:@]+@/g, '//[redacted]@')
}
