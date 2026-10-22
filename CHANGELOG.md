# Changelog

## [1.7.0-guan.0] — 2026-10-22

### Added: optional bearer-token auth for aggregator HTTP/SSE servers

Aggregator HTTP and SSE server connections now accept an `auth`
declaration. When present, every non-OPTIONS request must present the
API key as `Authorization: Bearer <key>` or `x-api-key: <key>`.

- `auth?: BearerAuthConfig` on `HttpServerConfig.connection` and
  `SseServerConfig.connection` (`{ type: 'bearer', env?: string }`).
  Config declares, the environment supplies: the key is read from the
  named environment variable (default `MCP_API_KEY`) and is never a
  config value.
- Constant-time comparison (sha256 both sides +
  `crypto.timingSafeEqual`); `401` + `WWW-Authenticate: Bearer` on
  failure (RFC 6750); `OPTIONS` preflight stays open.
- **Fail-closed:** a declared auth with an unset/empty secret refuses
  to boot (the CLI bin exits nonzero with an actionable error). A
  server configured for auth can never come up unauthenticated.
- Composition seam `buildExpressOptionsFromConfig` in
  `src/common/middleware/auth-from-config.ts`; the CLI bin resolves
  declared auth and threads it through the existing
  `ExpressOptions.preRouteMiddleware` path — applied on the aggregator
  http and sse entries; no behavior change when auth is not declared.
- Library consumers can wire the same middleware directly:
  `createBearerAuthMiddleware(secret)` from
  `src/common/middleware/bearer-auth.ts` is exported and unopinionated.

### Tests

44 new tests (27 middleware unit incl. real-express fetch smoke,
11 construction-seam, 6 aggregator http e2e over real sockets —
401/200/session establishment/backward compat). Suite: 80 passing
(36 baseline + 44 new).


## [1.6.7-guan.0] — 2026-09-13

### Fixed: `connection.host` now reaches the socket (all express entries)

All five express-based server entries (simple-server http/stateless-http/sse,
aggregator http/sse) called `app.listen(port)` bare — Node bound all
interfaces regardless of any host in config. The `host` field did not even
exist on the connection types, so TypeScript silently dropped it.

- `host?: string` added beside `port` on `HttpServerConfig.connection` and
  `SseServerConfig.connection`. When set (e.g. `'127.0.0.1'`), the server
  binds only that interface; when omitted, Node's default (all interfaces)
  applies — behavior-identical for every existing config.
- `start()` now returns the underlying `http.Server` (previously discarded —
  the reason this class of bug was invisible and untestable). Additive;
  existing callers unaffected.

### Fixed: aggregator SSE entry honors `connection.port`

The aggregator SSE entry took port as a `start()` argument (defaulting to 3000) and ignored `config.server.connection.port`, violating the declared
type contract and diverging from the aggregator http sibling. Port now
resolves config-first with `DEFAULT_PORT` fallback, matching the family
idiom (a configured `0` is treated as absent — documented in tests).

### Tests

Socket-level truth, no mocks: configured host binds (`server.address()`),
omitted host pins backward compat (all interfaces), LAN-addressed
connections REFUSED while loopback connects, aggregator SSE binds the exact
configured port. Suite: 36/36.

### Notes

- The gateway (HTTP transport) is unaffected: its config sets no `host`.
- Consumers using loopback-only binds may now drop deployment-level
  workarounds (e.g. systemd `IPAddressDeny`), though keeping them as
  defense-in-depth is reasonable.
