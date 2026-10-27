/**
 * Scope enforcement at the credential boundary.
 *
 * These tests exist because the SDK's scope precedence is
 * `explicit ?? server-advertised ?? client-metadata` (client/auth.js). A
 * resource server that advertises a broader set than we want therefore
 * outranks our own client metadata, and we cannot prevent the request from
 * asking for it. What we CAN do is refuse to keep the result. That refusal is
 * the security property this library ships, so it is tested here with an
 * explicit control mutation: remove the check in saveTokens() and
 * `refuses to persist a token carrying a denied scope` must fail.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createOAuthProvider,
  findDisallowedScopes,
  parseScope,
  readState,
  writeState,
  OAuthCredentialError,
} from '../../../src/common/oauth/provider'
import type { OAuthClientConfig } from '../../../src/common/types'

const baseConfig = (tokenFile: string): OAuthClientConfig => ({
  tokenFile,
  redirectUrl: 'http://127.0.0.1:8899/cb',
  scopes: ['user:read', 'banking-accounts:read'],
  allowedScopes: ['user:read', 'banking-accounts:read'],
  clientName: 'test-client',
})

describe('OAuth scope parsing', () => {
  it('splits a space-delimited scope string', () => {
    expect(parseScope('user:read banking-accounts:read')).to.deep.equal([
      'user:read',
      'banking-accounts:read',
    ])
  })

  it('treats undefined and empty as no scopes', () => {
    expect(parseScope(undefined)).to.deep.equal([])
    expect(parseScope('')).to.deep.equal([])
    expect(parseScope('   ')).to.deep.equal([])
  })

  it('drops empty members so a trailing space cannot look like a scope', () => {
    expect(parseScope('user:read  ')).to.deep.equal(['user:read'])
  })

  it('reports disallowed scopes, de-duplicated and in order', () => {
    expect(
      findDisallowedScopes(
        ['user:read', 'crypto:write', 'crypto:write', 'banking-cards-creds:read'],
        ['user:read']
      )
    ).to.deep.equal(['crypto:write', 'banking-cards-creds:read'])
  })

  it('accepts a strict subset of the allowlist', () => {
    expect(findDisallowedScopes(['user:read'], ['user:read', 'crypto:read'])).to.deep.equal([])
  })
})

describe('OAuth token persistence', () => {
  let dir: string
  let tokenFile: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ai-oauth-'))
    tokenFile = path.join(dir, 'tokens.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('treats a missing file as an ordinary first run, not an error', async () => {
    expect(await readState(tokenFile)).to.deep.equal({})
  })

  it('writes atomically at mode 600', async () => {
    await writeState(tokenFile, { tokens: { access_token: 'a', token_type: 'Bearer' } })
    const stat = await fs.stat(tokenFile)
    expect(stat.mode & 0o777).to.equal(0o600)
    const state = await readState(tokenFile)
    expect(state.tokens?.access_token).to.equal('a')
  })

  it('leaves no temp files behind after a write', async () => {
    await writeState(tokenFile, { codeVerifier: 'v' })
    const entries = await fs.readdir(dir)
    expect(entries).to.deep.equal(['tokens.json'])
  })

  it('REFUSES to read a token file that group or other can access', async () => {
    await writeState(tokenFile, { tokens: { access_token: 'a', token_type: 'Bearer' } })
    await fs.chmod(tokenFile, 0o644)
    let error: unknown
    try {
      await readState(tokenFile)
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(OAuthCredentialError)
    expect((error as Error).message).to.contain('chmod 600')
  })

  it('accepts a tightened 400 mode (owner read-only is a legitimate posture)', async () => {
    await writeState(tokenFile, { tokens: { access_token: 'a', token_type: 'Bearer' } })
    await fs.chmod(tokenFile, 0o400)
    const state = await readState(tokenFile)
    expect(state.tokens?.access_token).to.equal('a')
  })

  it('refuses to silently treat corrupt JSON as "no tokens"', async () => {
    await fs.writeFile(tokenFile, '{not json', { mode: 0o600 })
    let error: unknown
    try {
      await readState(tokenFile)
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(OAuthCredentialError)
    expect((error as Error).message).to.contain('not valid JSON')
  })
})

describe('OAuth provider scope enforcement', () => {
  let dir: string
  let tokenFile: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ai-scope-'))
    tokenFile = path.join(dir, 'tokens.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('persists a grant that is within the allowlist', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    await provider.saveTokens({
      access_token: 'a',
      token_type: 'Bearer',
      scope: 'user:read banking-accounts:read',
    })
    const state = await readState(tokenFile)
    expect(parseScope(state.tokens?.scope)).to.deep.equal([
      'user:read',
      'banking-accounts:read',
    ])
  })

  it('refuses to persist a token carrying a denied scope', async () => {
    // CONTROL MUTATION: remove the findDisallowedScopes check in saveTokens()
    // and this test must fail. If it passes either way, the check is not wired.
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    let error: unknown
    try {
      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        scope: 'user:read banking-cards-creds:read',
      })
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(OAuthCredentialError)
    expect((error as Error).message).to.contain('banking-cards-creds:read')
    // And crucially: nothing was written.
    expect(await readState(tokenFile)).to.deep.equal({})
  })

  it('does not disturb previously saved tokens when a bad grant is rejected', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    await provider.saveTokens({
      access_token: 'first',
      token_type: 'Bearer',
      scope: 'user:read',
    })
    let threw = false
    try {
      await provider.saveTokens({
        access_token: 'second',
        token_type: 'Bearer',
        scope: 'user:read crypto:write',
      })
    } catch {
      threw = true
    }
    expect(threw).to.equal(true)
    const state = await readState(tokenFile)
    expect(state.tokens?.access_token).to.equal('first')
  })

  it('validates a refresh response that omits scope against the accepted grant', async () => {
    // A refresh may legally omit `scope`, meaning "unchanged". We must not
    // treat that as "no scopes to check" and wave it through.
    const config: OAuthClientConfig = { ...baseConfig(tokenFile), allowedScopes: ['user:read'] }
    const provider = createOAuthProvider({ config })
    // Seed an accepted grant that is within the allowlist.
    await writeState(tokenFile, {
      tokens: { access_token: 'a', token_type: 'Bearer', scope: 'user:read' },
    })
    await provider.saveTokens({ access_token: 'b', token_type: 'Bearer' })
    const state = await readState(tokenFile)
    expect(state.tokens?.access_token).to.equal('b')
  })

  it('rejects a scope-less refresh when the stored grant was already out of policy', async () => {
    const config: OAuthClientConfig = { ...baseConfig(tokenFile), allowedScopes: ['user:read'] }
    const provider = createOAuthProvider({ config })
    // Simulate a file written by an older, laxer version.
    await writeState(tokenFile, {
      tokens: { access_token: 'a', token_type: 'Bearer', scope: 'user:read crypto:write' },
    })
    let error: unknown
    try {
      await provider.saveTokens({ access_token: 'b', token_type: 'Bearer' })
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(OAuthCredentialError)
    expect((error as Error).message).to.contain('crypto:write')
  })
})

describe('OAuth provider state slots', () => {
  let dir: string
  let tokenFile: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-ai-state-'))
    tokenFile = path.join(dir, 'tokens.json')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('keeps each saved slot independent', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    await provider.saveCodeVerifier('verifier-1')
    await provider.saveClientInformation({ client_id: 'c1' })
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', scope: 'user:read' })

    const state = await readState(tokenFile)
    expect(state.codeVerifier).to.equal('verifier-1')
    expect(state.clientInformation?.client_id).to.equal('c1')
    expect(state.tokens?.access_token).to.equal('a')
  })

  it('mints a fresh state value per call and persists it', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    const first = await provider.state!()
    const second = await provider.state!()
    expect(first).to.not.equal(second)
    const state = await readState(tokenFile)
    expect(state.oauthState).to.equal(second)
  })

  it('throws a clear error when no verifier has been stored', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    let error: unknown
    try {
      await provider.codeVerifier()
    } catch (e) {
      error = e
    }
    expect(error).to.be.instanceOf(OAuthCredentialError)
    expect((error as Error).message).to.contain('login')
  })

  it('invalidates only the named credential class', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    await provider.saveCodeVerifier('verifier-1')
    await provider.saveClientInformation({ client_id: 'c1' })
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', scope: 'user:read' })

    await provider.invalidateCredentials!('tokens')
    const afterTokens = await readState(tokenFile)
    expect(afterTokens.tokens).to.equal(undefined)
    expect(afterTokens.clientInformation?.client_id).to.equal('c1')
    expect(afterTokens.codeVerifier).to.equal('verifier-1')
  })

  it('invalidateCredentials("all") clears every slot', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    await provider.saveCodeVerifier('verifier-1')
    await provider.saveClientInformation({ client_id: 'c1' })
    await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', scope: 'user:read' })
    await provider.invalidateCredentials!('all')
    expect(await readState(tokenFile)).to.deep.equal({})
  })

  it('drops the state value together with the verifier', async () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    await provider.saveCodeVerifier('verifier-1')
    await provider.state!()
    await provider.invalidateCredentials!('verifier')
    const state = await readState(tokenFile)
    expect(state.codeVerifier).to.equal(undefined)
    expect(state.oauthState).to.equal(undefined)
  })

  it('reports the configured redirect and requested scope in client metadata', () => {
    const provider = createOAuthProvider({ config: baseConfig(tokenFile) })
    expect(String(provider.redirectUrl)).to.equal('http://127.0.0.1:8899/cb')
    expect(provider.clientMetadata.scope).to.equal('user:read banking-accounts:read')
    expect(provider.clientMetadata.token_endpoint_auth_method).to.equal('none')
  })
})
