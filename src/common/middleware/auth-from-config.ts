/**
 * Config-to-middleware construction for declared bearer auth.
 *
 * This is the seam between configuration and the bearer-auth middleware:
 * given a server connection object that MAY carry `auth`, produce the
 * middleware array to inject via `ExpressOptions.preRouteMiddleware`, or
 * an empty array when no auth is declared (fully backward compatible).
 *
 * Fail-closed contract: a declared `auth` with an unresolvable secret
 * throws at construction time — the caller (bin/mcp-aggregator.mts) lets
 * the error surface and the process exits nonzero. A server configured
 * for auth must NEVER come up without it.
 *
 * Unknown auth types throw for the same reason: a typo like
 * `"type": "beare"` must not silently disable authentication.
 */
import { createBearerAuthMiddleware, resolveBearerSecret } from './bearer-auth.js'
import type { BearerAuthConfig, ExpressMiddleware } from '../types.js'

/** The single auth type this library implements. */
export const SUPPORTED_AUTH_TYPE = 'bearer' as const

/** Any connection shape that carries the optional `auth` declaration. */
export type AuthDeclaringConnection = Readonly<{
  auth?: BearerAuthConfig
}>

/** The default environment variable consulted when auth.env is absent. */
export const DEFAULT_AUTH_ENV = 'MCP_API_KEY'

/**
 * Build pre-route middleware from a connection's auth declaration.
 *
 * @param connection - the server connection (http or sse); only `auth` is read.
 * @param env - the environment record (defaults to process.env; injectable
 *   for tests).
 * @returns pre-route middlewares to apply (empty when auth is not declared).
 * @throws when `auth` is declared but the secret cannot be resolved
 *   (fail-closed), or when the declared auth type is unsupported.
 */
export const buildAuthMiddlewareFromConnection = (
  connection: AuthDeclaringConnection,
  env: Readonly<Record<string, string | undefined>> = process.env
): ExpressMiddleware[] => {
  const auth = connection?.auth
  if (!auth) return []

  if (auth.type !== SUPPORTED_AUTH_TYPE) {
    throw new Error(
      `Unsupported server auth type: '${String(auth.type)}' (supported: '${SUPPORTED_AUTH_TYPE}')`
    )
  }

  const envName = auth.env ?? DEFAULT_AUTH_ENV
  const secret = resolveBearerSecret(envName, env)
  if (secret === null) {
    throw new Error(
      `Server auth is configured (connection.auth.type='bearer') but environment variable '${envName}' is unset or empty. ` +
        `Refusing to start unauthenticated (fail-closed). Set '${envName}' to the API key to boot.`
    )
  }

  return [createBearerAuthMiddleware(secret)]
}
