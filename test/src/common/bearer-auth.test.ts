/**
 * Bearer-auth middleware — unit tests.
 *
 * Coverage classes:
 * 1. extractPresentedKey: RFC 6750 Authorization parsing (case-insensitive
 *    scheme, whitespace tolerance, malformed → null) + x-api-key fallback
 *    + precedence + array-typed header rejection.
 * 2. resolveBearerSecret: env lookup incl. unset/empty/whitespace-only →
 *    null (fail-closed contract), custom env name, injected env record.
 * 3. createBearerAuthMiddleware (direct invocation): accept on both header
 *    forms, 401 + WWW-Authenticate on absence/mismatch, OPTIONS passthrough,
 *    sha256-normalized comparison (no length-mismatch throw).
 * 4. Real-express smoke: the middleware on an app listening on an ephemeral
 *    port answers 401/200 over actual HTTP (fetch) — the socket-truth layer
 *    below the pure-function tests.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import { createBearerAuthMiddleware, extractPresentedKey, resolveBearerSecret } from '../../../src/common/middleware/bearer-auth'
import type { ExpressMiddleware } from '../../../src/common/types'

const SECRET = 'test-secret-key-0123456789'

/** Invoke the middleware directly with a minimal fake request. */
const runMiddleware = (
  middleware: ExpressMiddleware,
  headers: Record<string, string | string[]>,
  method = 'POST'
): { status?: number; wwwAuthenticate?: string; body?: unknown; nextCalled: boolean } => {
  const captured: {
    status?: number
    wwwAuthenticate?: string
    body?: unknown
    nextCalled: boolean
  } = { nextCalled: false }
  const req = { headers, method } as unknown as import('express').Request
  const res = {
    status(code: number) {
      captured.status = code
      return {
        set(name: string, value: string) {
          if (name === 'WWW-Authenticate') captured.wwwAuthenticate = value
          return this
        },
        json(body: unknown) {
          captured.body = body
        },
      }
    },
  } as unknown as import('express').Response
  const next = () => {
    captured.nextCalled = true
  }
  middleware(req, res, next)
  return captured
}

describe('extractPresentedKey', () => {
  it('reads a Bearer token (canonical form)', () => {
    expect(extractPresentedKey({ headers: { authorization: `Bearer ${SECRET}` } })).to.equal(SECRET)
  })
  it('is case-insensitive on the scheme (RFC 6750)', () => {
    expect(extractPresentedKey({ headers: { authorization: `bearer ${SECRET}` } })).to.equal(SECRET)
    expect(extractPresentedKey({ headers: { authorization: `BEARER ${SECRET}` } })).to.equal(SECRET)
  })
  it('tolerates extra whitespace between scheme and token', () => {
    expect(extractPresentedKey({ headers: { authorization: `Bearer   ${SECRET}` } })).to.equal(SECRET)
  })
  it('returns null when the header is absent', () => {
    expect(extractPresentedKey({ headers: {} })).to.equal(null)
  })
  it('returns null on a non-bearer scheme', () => {
    expect(extractPresentedKey({ headers: { authorization: `Basic ${SECRET}` } })).to.equal(null)
  })
  it('returns null on an empty token after the scheme', () => {
    expect(extractPresentedKey({ headers: { authorization: 'Bearer ' } })).to.equal(null)
    expect(extractPresentedKey({ headers: { authorization: 'Bearer' } })).to.equal(null)
  })
  it('reads the x-api-key header as the raw key', () => {
    expect(extractPresentedKey({ headers: { 'x-api-key': SECRET } })).to.equal(SECRET)
  })
  it('prefers authorization when both headers are present', () => {
    expect(
      extractPresentedKey({
        headers: { authorization: `Bearer ${SECRET}`, 'x-api-key': 'other-key' },
      })
    ).to.equal(SECRET)
  })
  it('ignores array-typed header values (not acceptable presentations)', () => {
    expect(extractPresentedKey({ headers: { 'x-api-key': [SECRET] } })).to.equal(null)
  })
  it('falls through to x-api-key when authorization is malformed', () => {
    expect(
      extractPresentedKey({ headers: { authorization: 'garbage', 'x-api-key': SECRET } })
    ).to.equal(SECRET)
  })
})

describe('resolveBearerSecret', () => {
  it('returns the value when set', () => {
    expect(resolveBearerSecret('MCP_API_KEY', { MCP_API_KEY: SECRET })).to.equal(SECRET)
  })
  it('returns null when the variable is unset', () => {
    expect(resolveBearerSecret('MCP_API_KEY', {})).to.equal(null)
  })
  it('returns null when the variable is empty', () => {
    expect(resolveBearerSecret('MCP_API_KEY', { MCP_API_KEY: '' })).to.equal(null)
  })
  it('returns null when the variable is whitespace-only', () => {
    expect(resolveBearerSecret('MCP_API_KEY', { MCP_API_KEY: '   ' })).to.equal(null)
  })
  it('trims surrounding whitespace from a valid value', () => {
    expect(resolveBearerSecret('MCP_API_KEY', { MCP_API_KEY: `  ${SECRET}  ` })).to.equal(SECRET)
  })
  it('honors a custom environment variable name', () => {
    expect(resolveBearerSecret('CUSTOM_VAR', { CUSTOM_VAR: SECRET })).to.equal(SECRET)
    expect(resolveBearerSecret('CUSTOM_VAR', { MCP_API_KEY: SECRET })).to.equal(null)
  })
  it('defaults to MCP_API_KEY', () => {
    expect(resolveBearerSecret(undefined, { MCP_API_KEY: SECRET })).to.equal(SECRET)
  })
})

describe('createBearerAuthMiddleware (direct invocation)', () => {
  const middleware = createBearerAuthMiddleware(SECRET)

  it('calls next() on a matching Bearer token', () => {
    const result = runMiddleware(middleware, { authorization: `Bearer ${SECRET}` })
    expect(result.nextCalled).to.equal(true)
    expect(result.status).to.equal(undefined)
  })
  it('calls next() on a matching x-api-key', () => {
    const result = runMiddleware(middleware, { 'x-api-key': SECRET })
    expect(result.nextCalled).to.equal(true)
  })
  it('401s with WWW-Authenticate: Bearer when no key is presented', () => {
    const result = runMiddleware(middleware, {})
    expect(result.status).to.equal(401)
    expect(result.wwwAuthenticate).to.equal('Bearer')
    expect(result.nextCalled).to.equal(false)
    expect((result.body as { status: number }).status).to.equal(401)
  })
  it('401s on a wrong key', () => {
    const result = runMiddleware(middleware, { authorization: 'Bearer wrong-key' })
    expect(result.status).to.equal(401)
    expect(result.wwwAuthenticate).to.equal('Bearer')
    expect(result.nextCalled).to.equal(false)
  })
  it('401s on a wrong key of different length (sha256 normalization, no throw)', () => {
    const result = runMiddleware(middleware, { authorization: 'Bearer a' })
    expect(result.status).to.equal(401)
  })
  it('401s on a malformed authorization header', () => {
    const result = runMiddleware(middleware, { authorization: 'garbage' })
    expect(result.status).to.equal(401)
  })
  it('passes OPTIONS through without credentials (cors preflight)', () => {
    const result = runMiddleware(middleware, {}, 'OPTIONS')
    expect(result.nextCalled).to.equal(true)
    expect(result.status).to.equal(undefined)
  })
  it('accepts a key with surrounding whitespace in the header value', () => {
    const result = runMiddleware(middleware, { authorization: ` Bearer  ${SECRET}  ` })
    expect(result.nextCalled).to.equal(true)
  })
})

describe('bearer-auth on a real express app (ephemeral port, fetch)', () => {
  const servers: import('node:http').Server[] = []
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        s =>
          new Promise<void>(resolve => {
            if (s.listening) s.close(() => resolve())
            else resolve()
          })
      )
    )
  })

  const listen = async (app: express.Express): Promise<number> =>
    new Promise(resolve => {
      const server = app.listen(0, '127.0.0.1', () => {
        servers.push(server)
        resolve((server.address() as { port: number }).port)
      })
    })

  it('gates a plain route over real HTTP: 401 bare, 200 with key (both header forms)', async () => {
    const app = express()
    app.use(express.json())
    app.use(createBearerAuthMiddleware(SECRET))
    app.post('/', (_req, res) => {
      res.status(200).json({ ok: true })
    })
    const port = await listen(app)
    const base = `http://127.0.0.1:${port}/`

    const bare = await fetch(base, { method: 'POST', body: '{}' })
    expect(bare.status).to.equal(401)
    expect(bare.headers.get('www-authenticate')).to.equal('Bearer')

    const withBearer = await fetch(base, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
      body: '{}',
    })
    expect(withBearer.status).to.equal(200)

    const withApiKey = await fetch(base, {
      method: 'POST',
      headers: { 'x-api-key': SECRET },
      body: '{}',
    })
    expect(withApiKey.status).to.equal(200)

    const wrong = await fetch(base, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: '{}',
    })
    expect(wrong.status).to.equal(401)
  })

  it('lets OPTIONS preflight through without credentials over real HTTP', async () => {
    const app = express()
    app.use(createBearerAuthMiddleware(SECRET))
    app.post('/', (_req, res) => {
      res.status(200).json({ ok: true })
    })
    const port = await listen(app)

    const preflight = await fetch(`http://127.0.0.1:${port}/`, { method: 'OPTIONS' })
    expect(preflight.status).to.not.equal(401)
  })
})
