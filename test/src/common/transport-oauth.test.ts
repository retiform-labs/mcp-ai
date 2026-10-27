/**
 * The transport seam.
 *
 * Both defects this covers were silent: createTransport() discarded the whole
 * options object, so `connection.headers` never reached the request and no
 * authProvider could ever be supplied. Neither threw, neither logged, and the
 * only http child in production happens to authenticate via a query-string
 * token, so nothing noticed. These tests inspect the constructed transport's
 * own fields for exactly that reason -- the assertion is about what the object
 * actually holds, not about what the call site intended.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTransport, toMcpConfig } from '../../../src/common/libs'
import type { HttpConnection } from '../../../src/common/types'

/** The transport keeps its constructor options in these fields. */
type TransportInternals = {
  _requestInit?: { headers?: Record<string, string> }
  _authProvider?: unknown
  _fetch?: unknown
}

describe('toMcpConfig — http options mapping', () => {
  it('carries headers into requestInit', () => {
    const connection: HttpConnection = {
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { 'X-Test': 'yes' },
    }
    const options = toMcpConfig(connection)
    expect(options.requestInit?.headers).to.deep.equal({ 'X-Test': 'yes' })
  })

  it('omits authProvider when no oauth block is declared', () => {
    const options = toMcpConfig({ type: 'http', url: 'https://example.test/mcp' })
    expect(options.authProvider).to.equal(undefined)
    expect(options.fetch).to.equal(undefined)
  })

  it('supplies an authProvider when oauth is declared', () => {
    const options = toMcpConfig({
      type: 'http',
      url: 'https://example.test/mcp',
      oauth: {
        tokenFile: '/tmp/does-not-need-to-exist.json',
        redirectUrl: 'http://127.0.0.1:8899/cb',
        scopes: ['user:read'],
        allowedScopes: ['user:read'],
      },
    })
    expect(options.authProvider).to.not.equal(undefined)
    // The provider must answer the contract the SDK reads synchronously.
    expect(String((options.authProvider as { redirectUrl: string }).redirectUrl)).to.equal(
      'http://127.0.0.1:8899/cb'
    )
  })

  it('supplies a UA-carrying fetch when userAgent is configured', () => {
    const options = toMcpConfig({
      type: 'http',
      url: 'https://example.test/mcp',
      oauth: {
        tokenFile: '/tmp/does-not-need-to-exist.json',
        redirectUrl: 'http://127.0.0.1:8899/cb',
        scopes: ['user:read'],
        allowedScopes: ['user:read'],
        userAgent: 'mcp-ai-test/9.9.9',
      },
    })
    expect(options.fetch).to.be.a('function')
  })
})

describe('createTransport — the seam is actually used', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ai-transport-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('passes connection.headers to the http transport', () => {
    // CONTROL MUTATION: revert createTransport to
    // `new StreamableHTTPClientTransport(new URL(url))` and this must fail.
    const transport = createTransport({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer abc' },
    }) as unknown as TransportInternals
    expect(transport._requestInit?.headers).to.deep.equal({ Authorization: 'Bearer abc' })
  })

  it('passes an authProvider to the http transport when oauth is declared', () => {
    // CONTROL MUTATION: drop the `authProvider` key from toMcpConfig's return
    // and this must fail.
    const transport = createTransport({
      type: 'http',
      url: 'https://example.test/mcp',
      oauth: {
        tokenFile: path.join(dir, 'tokens.json'),
        redirectUrl: 'http://127.0.0.1:8899/cb',
        scopes: ['user:read'],
        allowedScopes: ['user:read'],
      },
    }) as unknown as TransportInternals
    expect(transport._authProvider).to.not.equal(undefined)
  })

  it('leaves an oauth-less http transport without an authProvider (backward compat)', () => {
    const transport = createTransport({
      type: 'http',
      url: 'https://example.test/mcp',
    }) as unknown as TransportInternals
    expect(transport._authProvider).to.equal(undefined)
  })

  it('routes the authorization URL to the injected sink, not the console', async () => {
    const seen: string[] = []
    const options = toMcpConfig(
      {
        type: 'http',
        url: 'https://example.test/mcp',
        oauth: {
          tokenFile: path.join(dir, 'tokens.json'),
          redirectUrl: 'http://127.0.0.1:8899/cb',
          scopes: ['user:read'],
          allowedScopes: ['user:read'],
        },
      },
      { onAuthorizationUrl: (url) => seen.push(String(url)) }
    )
    const provider = options.authProvider as { redirectToAuthorization: (u: URL) => void }
    await provider.redirectToAuthorization(new URL('https://auth.test/authorize?x=1'))
    expect(seen).to.deep.equal(['https://auth.test/authorize?x=1'])
  })
})
