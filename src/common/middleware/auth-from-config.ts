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
import type {
  BearerAuthConfig,
  ExpressMiddleware,
  ExpressOptions,
} from '../types.js'
import {
  createBearerAuthMiddleware,
  resolveBearerSecret,
} from './bearer-auth.js'

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
  if (!auth) {
    return []
  }

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

/** Minimal structural view of an aggregator config the seam needs. */
export type AuthDeclaringConfig = Readonly<{
  server: {
    connection: AuthDeclaringConnection
  }
}>

/**
 * Build the ExpressOptions to hand to the aggregator's create() from a
 * full aggregator config. This is the composition-root seam the CLI bin
 * uses: config declares auth, this resolves it (fail-closed), and the
 * existing options threading in src/aggregator/entries/index.ts applies
 * it to the express entries.
 *
 * @param config - an aggregator config (http or sse server shape; other
 *   server types carry no auth field and yield undefined).
 * @param env - environment record (defaults to process.env; injectable).
 * @returns ExpressOptions carrying the pre-route auth middleware, or
 *   undefined when no auth is declared (fully backward compatible).
 * @throws under the same fail-closed rules as buildAuthMiddlewareFromConnection.
 */
export const buildExpressOptionsFromConfig = (
  config: AuthDeclaringConfig,
  env: Readonly<Record<string, string | undefined>> = process.env
): ExpressOptions | undefined => {
  const middlewares = buildAuthMiddlewareFromConnection(
    config.server.connection,
    env
  )
  if (middlewares.length === 0) {
    return undefined
  }
  return { preRouteMiddleware: middlewares }
}
