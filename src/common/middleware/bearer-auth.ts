/**
 * Bearer-auth middleware for express-based MCP server entries.
 *
 * Module role (composition root friendly): a pure factory that turns a
 * resolved secret into a pre-route express middleware. The factory knows
 * nothing about configuration files or environment — callers resolve the
 * secret (typically via `resolveBearerSecret` below or their own mechanism)
 * and hand it in. This keeps the middleware unit-testable and lets library
 * consumers wire it through `ExpressOptions.preRouteMiddleware` without
 * inheriting any config-schema coupling.
 *
 * Security posture:
 * - Accepts both `Authorization: Bearer <key>` (RFC 6750) and the
 *   OpenAI-style `x-api-key: <key>` header, for ecosystem interop.
 * - Comparison is constant-time: both sides are hashed with sha256 before
 *   `crypto.timingSafeEqual`, which also normalizes length (timingSafeEqual
 *   throws on length mismatch, and the raw-length leak is itself a probe).
 * - 401 responses carry `WWW-Authenticate: Bearer` per RFC 6750 and never
 *   echo any part of the expected key.
 * - OPTIONS requests pass through untouched: `cors()` runs earlier in the
 *   middleware chain, and preflight requests do not carry credentials by
 *   spec — gating them would break browser clients without adding
 *   security (the preflight carries no authorization decision).
 * - The middleware logs nothing: access logs live with the operator, and
 *   a log line here would risk echoing presented (possibly secret-ish)
 *   material into journals.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { ExpressMiddleware } from '../types.js'

/** Headers accepted for presenting the API key, checked in order. */
const PRESENTATION_HEADERS = ['authorization', 'x-api-key'] as const

/** The `Authorization` scheme this middleware accepts. */
const BEARER_PREFIX = 'bearer '

/** HTTP status for a failed or absent API key presentation. */
const HTTP_UNAUTHORIZED = 401

/** sha256 a string to a fixed-length buffer for timing-safe comparison. */
const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest()

/**
 * Extract the presented key from a request, or null when no acceptable
 * presentation is found. Malformed presentations (wrong scheme, empty
 * value) yield null and are treated identically to absence.
 */
export const extractPresentedKey = (
  req: Pick<import('express').Request, 'headers'>
): string | null => {
  // First acceptable presentation wins (authorization has precedence over
  // x-api-key). Presented via a pure projection + find rather than an
  // imperative loop (functional style).
  const presented = PRESENTATION_HEADERS.map(header => {
    const raw = req.headers[header]
    if (typeof raw !== 'string') {return null} // absent or array-typed → not acceptable

    const trimmed = raw.trim()
    if (trimmed.length === 0) {return null}

    if (header === 'authorization') {
      // RFC 6750: case-insensitive scheme, single space, non-empty token.
      const lower = trimmed.toLowerCase()
      if (!lower.startsWith(BEARER_PREFIX)) {return null}
      const token = trimmed.slice(BEARER_PREFIX.length).trim()
      return token.length > 0 ? token : null
    }

    // x-api-key: the raw header value is the key.
    return trimmed
  }).find(value => value !== null)

  return presented ?? null
}

/**
 * Build the bearer-auth middleware for a resolved secret.
 *
 * @param secret - the expected API key (already resolved from the
 *   environment by the caller; never a config-file value).
 * @returns an express middleware that 401s any request without a matching
 *   key and calls next() otherwise.
 */
export const createBearerAuthMiddleware = (
  secret: string
): ExpressMiddleware => {
  const expected = sha256(secret)

  const middleware: ExpressMiddleware = async (req, res, next) => {
    // Preflight requests carry no credentials by spec; let cors() answers through.
    if (req.method === 'OPTIONS') {
      next()
      return
    }

    const presented = extractPresentedKey(req)
    if (presented === null) {
      res.status(HTTP_UNAUTHORIZED).set('WWW-Authenticate', 'Bearer').json({
        error: 'Unauthorized',
        message: 'Missing API key',
        status: HTTP_UNAUTHORIZED,
      })
      return
    }

    const match = timingSafeEqual(sha256(presented), expected)
    if (!match) {
      res.status(HTTP_UNAUTHORIZED).set('WWW-Authenticate', 'Bearer').json({
        error: 'Unauthorized',
        message: 'Invalid API key',
        status: HTTP_UNAUTHORIZED,
      })
      return
    }

    next()
  }

  return middleware
}

/**
 * Resolve the expected secret from the environment.
 *
 * Fail-closed by design: when `envName` (or the default) is unset or empty,
 * this returns null and the caller MUST refuse to boot — a server that
 * silently starts without a resolvable secret while auth is configured is
 * the single worst failure mode of this feature.
 *
 * @param envName - environment variable to read (defaults to MCP_API_KEY).
 * @param env - the environment record to read from (defaults to process.env
 *   for production use; injectable for tests).
 * @returns the resolved secret, or null when absent/empty (fail-closed).
 */
export const resolveBearerSecret = (
  envName: string = 'MCP_API_KEY',
  env: Readonly<Record<string, string | undefined>> = process.env
): string | null => {
  const value = env[envName]
  if (typeof value !== 'string') {return null}
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
