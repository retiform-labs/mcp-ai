/**
 * Interactive OAuth login for a single aggregator child.
 *
 * Deliberately a SEPARATE command from serving. The aggregator's startup uses
 * `Promise.allSettled`, so a blocking authorization await inside `connect()`
 * would be swallowed by that and silently park the child forever. Making login
 * its own one-shot process keeps the server's contract simple: it reads tokens
 * it finds and never waits on a human.
 *
 * The loopback constraint is imposed by providers, not by us: RFC 8252 says a
 * native client's redirect URI must be `http://127.0.0.1:<port>/...`, and an
 * authorization server is entitled to reject anything else. That means the
 * browser completing the flow must run on the SAME machine as this listener --
 * loopback is machine-wide, not per-user, so any local account's browser works.
 *
 * Failure modes are made loud on purpose. A login that appears to succeed
 * while writing nothing is the single most expensive kind of failure here,
 * because it costs a fresh consent from the account holder.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { createOAuthProvider, parseScope, readState } from './provider.js'
import type { OAuthClientConfig } from '../types.js'

/** Default window for a human to finish a consent screen. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000

export type LoginResult = Readonly<{
  tokenFile: string
  grantedScope: string[]
  authorizationServer: string
}>

export type LoginOptions = Readonly<{
  serverUrl: string
  config: OAuthClientConfig
  /** How long to wait for the browser to come back. */
  timeoutMs?: number
  /** Where to print progress and the authorization URL. Defaults to stderr. */
  log?: (message: string) => void
}>

/** Parse the port from a loopback redirect URI, failing clearly if absent. */
export const portFromRedirectUrl = (redirectUrl: string): number => {
  let parsed: URL
  try {
    parsed = new URL(redirectUrl)
  } catch {
    throw new Error(`redirectUrl '${redirectUrl}' is not a valid URL`)
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(
      `redirectUrl '${redirectUrl}' must specify an explicit port (e.g. http://127.0.0.1:8899/cb). ` +
        `Authorization servers require a loopback host with a known port.`
    )
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(
      `redirectUrl '${redirectUrl}' must use a loopback host (127.0.0.1 or localhost). ` +
        `Most providers reject anything else at the authorization endpoint.`
    )
  }
  return port
}

/**
 * Wait for the authorization callback, returning the `code` parameter.
 *
 * Every outcome is written to the HTTP response so the browser shows something
 * meaningful, and every failure is surfaced as a rejection so the caller can
 * exit non-zero. A listener that resolves on a missing code would turn a
 * provider error into a silent no-op.
 */
export const awaitCallback = (
  redirectUrl: string,
  expectedState: string | undefined,
  timeoutMs: number,
  log: (message: string) => void
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const port = portFromRedirectUrl(redirectUrl)
    const expectedPath = new URL(redirectUrl).pathname
    let settled = false

    // Release the port, then settle -- never the other way round, and never
    // INSIDE server.close()'s callback.
    //
    // Two traps here, both measured. Settling before close() lets a caller
    // rebind while the socket is still held, which surfaces as a spurious
    // EADDRINUSE on the next attempt. But waiting for close()'s callback
    // deadlocks instead: an HTTP client using keep-alive leaves its socket
    // open, close() waits for every socket, and the callback never fires. So
    // close, force the lingering connections down, and settle immediately.
    const finish = (err: Error | null, code?: string): void => {
      if (settled) {return}
      settled = true
      clearTimeout(timer)
      server.close()
      // Present since Node 18.2; the optional call keeps this safe on any
      // runtime that predates it rather than failing to compile a listener.
      server.closeAllConnections?.()
      if (err) {reject(err)} else {resolve(code as string)}
    }

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)

      // Only the configured path is a callback. Anything else gets a short
      // answer instead of being passed through as if it might be the code --
      // favicon requests and stray probes both land here.
      if (url.pathname !== expectedPath) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not the OAuth callback path.\n')
        return
      }

      const error = url.searchParams.get('error')
      if (error) {
        const description = url.searchParams.get('error_description') ?? ''
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end(`Authorization failed: ${error}\n`)
        finish(new Error(`Authorization failed: ${error}${description ? ` - ${description}` : ''}`))
        return
      }

      // CSRF check. The SDK mints a state value and appends it to the
      // authorization URL but never compares it on return, so without this a
      // forged callback would be indistinguishable from a real one.
      const returnedState = url.searchParams.get('state') ?? undefined
      if (expectedState !== undefined && returnedState !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Authorization failed: state mismatch.\n')
        finish(
          new Error(
            `State mismatch on the authorization callback. Expected '${expectedState}' but received ` +
              `'${returnedState ?? '(none)'}'. The request was not the one this process started; nothing was saved.`
          )
        )
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Authorization failed: no code in the callback.\n')
        finish(new Error('The callback carried no authorization code.'))
        return
      }

      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('Authorization received. You can close this window.\n')
      log('[login] authorization code received')
      finish(null, code)
    })

    const timer = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the authorization callback on port ${port}. ` +
            `The browser must run on THIS host (loopback redirect), and the window must be left open until it ` +
            `shows the confirmation page.`
        )
      )
    }, timeoutMs)

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        finish(
          new Error(
            `Port ${port} is already in use. Another login is probably still running, or an earlier one did not ` +
              `shut down. Stop it, or change the port in both redirectUrl and the provider's registration.`
          )
        )
        return
      }
      finish(err)
    })

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      log(`[login] listening on http://127.0.0.1:${addr.port}${expectedPath}`)
    })
  })

/**
 * Run the full flow: discover, authorize, wait, exchange, persist.
 *
 * Returns the granted scope read back FROM DISK after the exchange, so the
 * caller reports what was actually stored rather than what was requested.
 * Those can differ, and only the stored one is real.
 */
export const login = async (options: LoginOptions): Promise<LoginResult> => {
  const log = options.log ?? ((m: string) => console.error(m))
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS

  const provider: OAuthClientProvider = createOAuthProvider({
    config: options.config,
    onAuthorizationUrl: (url) => {
      // Printed with its own marker so it is easy to copy out of a terminal or
      // a systemd journal without dragging surrounding prose along.
      log('[login] Open this URL in a browser on THIS machine:')
      log(String(url))
    },
  })

  // First pass: direct the user. `auth()` performs discovery, obtains client
  // information, and calls redirectToAuthorization, then returns 'REDIRECT'.
  const first = await auth(provider, {
    serverUrl: options.serverUrl,
    scope: options.config.scopes.join(' '),
  })

  if (first === 'AUTHORIZED') {
    // Tokens were already present and still valid. Nothing to do.
    const state = await readState(options.config.tokenFile)
    log('[login] existing tokens are still valid; nothing to change')
    return {
      tokenFile: options.config.tokenFile,
      grantedScope: parseScope(state.tokens?.scope),
      authorizationServer: options.serverUrl,
    }
  }

  // The state value was persisted by provider.state() during the call above.
  const pending = await readState(options.config.tokenFile)
  const code = await awaitCallback(
    options.config.redirectUrl,
    pending.oauthState,
    timeoutMs,
    log
  )

  // Second pass: exchange the code. saveTokens() enforces the scope allowlist
  // and throws without writing if the grant exceeds it.
  const second = await auth(provider, {
    serverUrl: options.serverUrl,
    authorizationCode: code,
    scope: options.config.scopes.join(' '),
  })

  if (second !== 'AUTHORIZED') {
    throw new Error(
      `Code exchange did not complete (result: ${second}). The authorization code may have expired or already been used.`
    )
  }

  const stored = await readState(options.config.tokenFile)
  if (!stored.tokens) {
    // Defensive: a successful exchange that wrote nothing would be the worst
    // possible outcome -- it consumes a consent and leaves no credential.
    throw new Error(
      `The exchange reported success but no tokens are present in '${options.config.tokenFile}'. Nothing was saved.`
    )
  }

  return {
    tokenFile: options.config.tokenFile,
    grantedScope: parseScope(stored.tokens.scope),
    authorizationServer: options.serverUrl,
  }
}

/** Read and minimally shape-check an aggregator config file. */
export const loadAggregatorConfig = (
  configPath: string
): { mcps: Array<{ id: string; connection: Record<string, unknown> }> } => {
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  const aggregator = (raw.aggregator ?? raw) as { mcps?: unknown }
  if (!Array.isArray(aggregator.mcps)) {
    throw new Error(`Config '${configPath}' has no aggregator.mcps array`)
  }
  return { mcps: aggregator.mcps as Array<{ id: string; connection: Record<string, unknown> }> }
}
