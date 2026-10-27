/**
 * The loopback callback listener.
 *
 * The SDK mints an OAuth `state` value and appends it to the authorization URL
 * but never compares it on return, so CSRF validation is the client's job and
 * this is where we do it. A forged callback and a real one are otherwise
 * indistinguishable, which is why the mismatch case is tested against a live
 * HTTP request rather than against a pure function -- the check has to survive
 * the trip through the listener to be worth anything.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  awaitCallback,
  portFromRedirectUrl,
} from '../../../src/common/oauth/login'

describe('login — redirect URL validation', () => {
  it('extracts the port from a loopback redirect URL', () => {
    expect(portFromRedirectUrl('http://127.0.0.1:8899/cb')).to.equal(8899)
    expect(
      portFromRedirectUrl('http://localhost:3000/oauth/callback')
    ).to.equal(3000)
  })

  it('refuses a redirect URL with no explicit port', () => {
    // Authorization servers require a known port on a loopback redirect; a
    // default-port URL cannot be pre-registered and would be rejected later
    // with a much less obvious error.
    expect(() => portFromRedirectUrl('http://127.0.0.1/cb')).to.throw(
      /explicit port/
    )
  })

  it('refuses a non-loopback redirect URL', () => {
    expect(() => portFromRedirectUrl('https://mcp.example.com/cb')).to.throw(
      /loopback/
    )
    expect(() => portFromRedirectUrl('http://10.20.30.40:8899/cb')).to.throw(
      /loopback/
    )
  })

  it('refuses something that is not a URL at all', () => {
    expect(() => portFromRedirectUrl('not a url')).to.throw(/not a valid URL/)
  })
})

describe('login — the callback listener over real HTTP', () => {
  const port = 18899
  const redirectUrl = `http://127.0.0.1:${port}/cb`
  const noop = (): void => {}

  it('accepts a code when the state matches', async () => {
    const pending = awaitCallback(redirectUrl, 'expected-state', 5000, noop)
    const res = await fetch(`${redirectUrl}?code=abc123&state=expected-state`)
    expect(res.status).to.equal(200)
    expect(await pending).to.equal('abc123')
  })

  it('REFUSES a callback whose state does not match', async () => {
    // CONTROL MUTATION: delete the returnedState comparison and this must fail.
    // Without it, a forged callback is accepted as genuine.
    const pending = awaitCallback(redirectUrl, 'expected-state', 5000, noop)
    const res = await fetch(`${redirectUrl}?code=abc123&state=forged`)
    expect(res.status).to.equal(400)
    let error: unknown
    try {
      await pending
    } catch (e) {
      error = e
    }
    expect((error as Error).message).to.contain('State mismatch')
  })

  it('REFUSES a callback carrying no state when one was expected', async () => {
    const pending = awaitCallback(redirectUrl, 'expected-state', 5000, noop)
    await fetch(`${redirectUrl}?code=abc123`)
    let error: unknown
    try {
      await pending
    } catch (e) {
      error = e
    }
    expect((error as Error).message).to.contain('State mismatch')
  })

  it('surfaces a provider error instead of waiting out the timeout', async () => {
    const pending = awaitCallback(redirectUrl, 'expected-state', 5000, noop)
    await fetch(
      `${redirectUrl}?error=access_denied&error_description=nope&state=expected-state`
    )
    let error: unknown
    try {
      await pending
    } catch (e) {
      error = e
    }
    expect((error as Error).message).to.contain('access_denied')
  })

  it('refuses a callback with no code', async () => {
    const pending = awaitCallback(redirectUrl, 'expected-state', 5000, noop)
    await fetch(`${redirectUrl}?state=expected-state`)
    let error: unknown
    try {
      await pending
    } catch (e) {
      error = e
    }
    expect((error as Error).message).to.contain('no authorization code')
  })

  it('answers 404 on a non-callback path so probes cannot be mistaken for a code', async () => {
    const pending = awaitCallback(redirectUrl, 'expected-state', 5000, noop)
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
    expect(res.status).to.equal(404)
    // Then the real callback still completes.
    await fetch(`${redirectUrl}?code=xyz&state=expected-state`)
    expect(await pending).to.equal('xyz')
  })

  it('times out rather than hanging forever', async () => {
    let error: unknown
    try {
      await awaitCallback(redirectUrl, 'expected-state', 150, noop)
    } catch (e) {
      error = e
    }
    expect((error as Error).message).to.contain('Timed out')
  })

  it('reports a clear error when the port is already in use', async () => {
    const first = awaitCallback(redirectUrl, 's1', 5000, noop)
    let error: unknown
    try {
      await awaitCallback(redirectUrl, 's2', 5000, noop)
    } catch (e) {
      error = e
    }
    expect((error as Error).message).to.contain('already in use')
    await fetch(`${redirectUrl}?code=done&state=s1`)
    await first
  })
})
