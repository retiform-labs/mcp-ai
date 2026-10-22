/**
 * Aggregator HTTP entry — bearer-auth e2e (v1.7.0).
 *
 * Socket-level truth, no mocks: the REAL aggregator http entry is created
 * and started exactly the way bin/mcp-aggregator.mts composes it
 * (config + buildExpressOptionsFromConfig -> create(config, { express })),
 * bound to an ephemeral loopback port, and driven with real HTTP requests.
 *
 * Coverage classes:
 * 1. Auth declared: initialize without a key -> 401 + WWW-Authenticate:
 *    Bearer; with the key (both header forms) -> 200 and a real MCP
 *    session is established (mcp-session-id header present).
 * 2. Backward compatibility: no auth declared -> unauthenticated
 *    initialize succeeds exactly as before v1.7.0.
 * 3. Wrong key -> 401.
 * 4. OPTIONS preflight passes without credentials (cors order preserved).
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import * as net from 'net'
import { create as createAggregator } from '../../../src/aggregator/entries'
import { buildExpressOptionsFromConfig } from '../../../src/common/middleware/auth-from-config'
import { McpAggregatorHttpConfig } from '../../../src/common/types'

const SECRET = 'e2e-secret-key-abcdef0123456789'

const httpConfig = (auth?: Record<string, unknown>): McpAggregatorHttpConfig =>
  ({
    mcps: [],
    server: {
      path: '/',
      connection: {
        type: 'http',
        url: 'http://127.0.0.1:0',
        ...(auth ? { auth } : {}),
      },
    },
  }) as unknown as McpAggregatorHttpConfig

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'bearer-auth-e2e', version: '1.0.0' },
  },
})

/** Compose + start exactly as the bin does; resolve the real bound port. */
const startAsBin = async (config: McpAggregatorHttpConfig): Promise<net.Server> => {
  const expressOptions = buildExpressOptionsFromConfig(
    config as unknown as Parameters<typeof buildExpressOptionsFromConfig>[0],
    { MCP_API_KEY: SECRET }
  )
  const aggregator = createAggregator(
    config,
    expressOptions ? { express: expressOptions } : undefined
  )
  const server = (await aggregator.start()) as net.Server
  return server
}

const servers: net.Server[] = []
const transports: { stop: () => Promise<void> }[] = []
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
  transports.splice(0)
})

const post = async (
  port: number,
  headers: Record<string, string> = {}
): Promise<{ status: number; wwwAuthenticate?: string; sessionId?: string }> => {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    // The MCP streamable HTTP transport rejects requests without the
    // spec'd Accept pair (406) — real clients always send it. This is a
    // transport requirement, orthogonal to auth.
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INITIALIZE_BODY,
  })
  return {
    status: res.status,
    wwwAuthenticate: res.headers.get('www-authenticate') ?? undefined,
    sessionId: res.headers.get('mcp-session-id') ?? undefined,
  }
}

describe('Aggregator HTTP entry — bearer auth e2e (v1.7.0)', () => {
  it('401s an unauthenticated initialize with WWW-Authenticate: Bearer', async () => {
    const server = await startAsBin(httpConfig({ type: 'bearer' }))
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const res = await post(port)
    expect(res.status).to.equal(401)
    expect(res.wwwAuthenticate).to.equal('Bearer')
    expect(res.sessionId).to.equal(undefined)
  })

  it('accepts Authorization: Bearer and establishes a real MCP session', async () => {
    const server = await startAsBin(httpConfig({ type: 'bearer' }))
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const res = await post(port, { authorization: `Bearer ${SECRET}` })
    expect(res.status).to.equal(200)
    expect(res.sessionId).to.be.a('string').with.length.above(0)
  })

  it('accepts x-api-key as the presentation header', async () => {
    const server = await startAsBin(httpConfig({ type: 'bearer' }))
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const res = await post(port, { 'x-api-key': SECRET })
    expect(res.status).to.equal(200)
  })

  it('401s a wrong key', async () => {
    const server = await startAsBin(httpConfig({ type: 'bearer' }))
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const res = await post(port, { authorization: 'Bearer wrong' })
    expect(res.status).to.equal(401)
  })

  it('keeps OPTIONS preflight open without credentials', async () => {
    const server = await startAsBin(httpConfig({ type: 'bearer' }))
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'OPTIONS' })
    expect(res.status).to.not.equal(401)
  })

  it('backward compat: no auth declared -> unauthenticated initialize succeeds', async () => {
    const server = await startAsBin(httpConfig())
    servers.push(server)
    const port = (server.address() as { port: number }).port

    const res = await post(port)
    expect(res.status).to.equal(200)
    expect(res.sessionId).to.be.a('string').with.length.above(0)
  })
})
