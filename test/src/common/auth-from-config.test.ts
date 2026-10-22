/**
 * auth-from-config — construction seam tests.
 *
 * Coverage classes:
 * 1. No auth declared → empty array (backward compatibility).
 * 2. Declared + resolvable secret → exactly one middleware, which gates
 *    requests (behavioral check through the middleware, not shape-only).
 * 3. Fail-closed: declared + unset/empty env → throws with an actionable
 *    message naming the variable.
 * 4. Unsupported auth type → throws (typo protection).
 * 5. Custom env name honored; DEFAULT_AUTH_ENV used when env is absent.
 */
import { describe, it } from 'mocha'
import { expect } from 'chai'
import express from 'express'
import {
  buildAuthMiddlewareFromConnection,
  DEFAULT_AUTH_ENV,
} from '../../../src/common/middleware/auth-from-config'
import type { ExpressMiddleware } from '../../../src/common/types'

const SECRET = 'config-secret-key-9876543210'

const runThrough = (middleware: ExpressMiddleware | undefined, headers: Record<string, string>) => {
  let nextCalled = false
  let status: number | undefined
  middleware?.({ headers, method: 'POST' } as unknown as import('express').Request, {
    status(code: number) {
      status = code
      return { set: () => this, json: () => undefined }
    },
  } as unknown as import('express').Response, () => {
    nextCalled = true
  })
  return { nextCalled, status }
}

describe('buildAuthMiddlewareFromConnection', () => {
  it('returns an empty array when no auth is declared (backward compat)', () => {
    expect(buildAuthMiddlewareFromConnection({})).to.deep.equal([])
    expect(buildAuthMiddlewareFromConnection({ auth: undefined })).to.deep.equal([])
  })

  it('builds one gating middleware when declared with a resolvable secret', () => {
    const [middleware] = buildAuthMiddlewareFromConnection(
      { auth: { type: 'bearer' } },
      { MCP_API_KEY: SECRET }
    )
    expect(middleware).to.be.a('function')

    expect(runThrough(middleware, { authorization: `Bearer ${SECRET}` }).nextCalled).to.equal(true)
    expect(runThrough(middleware, {}).status).to.equal(401)
  })

  it('reads the custom env variable named by auth.env', () => {
    const [middleware] = buildAuthMiddlewareFromConnection(
      { auth: { type: 'bearer', env: 'MY_KEY_VAR' } },
      { MY_KEY_VAR: SECRET }
    )
    expect(runThrough(middleware, { 'x-api-key': SECRET }).nextCalled).to.equal(true)
  })

  it('throws (fail-closed) when auth is declared but the env variable is unset', () => {
    expect(() => buildAuthMiddlewareFromConnection({ auth: { type: 'bearer' } }, {})).to.throw(
      /MCP_API_KEY/
    )
  })

  it('throws (fail-closed) when the env variable is empty', () => {
    expect(() =>
      buildAuthMiddlewareFromConnection({ auth: { type: 'bearer' } }, { MCP_API_KEY: '' })
    ).to.throw(/fail-closed/)
  })

  it('throws on an unsupported auth type (typo protection)', () => {
    expect(() =>
      buildAuthMiddlewareFromConnection(
        { auth: { type: 'beare' } as unknown as { type: 'bearer' } },
        { MCP_API_KEY: SECRET }
      )
    ).to.throw(/Unsupported server auth type/)
  })

  it('exposes DEFAULT_AUTH_ENV = MCP_API_KEY', () => {
    expect(DEFAULT_AUTH_ENV).to.equal('MCP_API_KEY')
  })

  it('wires through a real express app: 401 bare, 200 with key', async () => {
    const [middleware] = buildAuthMiddlewareFromConnection(
      { auth: { type: 'bearer' } },
      { MCP_API_KEY: SECRET }
    )
    const app = express()
    app.use(express.json())
    app.use(middleware)
    app.post('/', (_req, res) => res.status(200).json({ ok: true }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const bare = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}' })
      expect(bare.status).to.equal(401)
      const keyed = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
        body: '{}',
      })
      expect(keyed.status).to.equal(200)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
