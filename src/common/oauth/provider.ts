/**
 * OAuth 2.1 client-provider state for `http` connections.
 *
 * The MCP SDK already implements the protocol: discovery, dynamic client
 * registration, PKCE, code exchange, refresh-on-401 and a circuit breaker
 * against post-auth recursion all live in `@modelcontextprotocol/sdk`. What
 * it cannot do is remember anything -- persistence is delegated to an
 * `OAuthClientProvider`, and that is the only thing this module supplies.
 *
 * Two properties are load-bearing and are the reason this is not a thin
 * key-value wrapper:
 *
 *  1. SCOPE ENFORCEMENT AT THE CREDENTIAL BOUNDARY. The SDK resolves the
 *     requested scope as `explicit ?? server-advertised ?? client-metadata`
 *     (client/auth.js). A resource server that advertises a broader set than
 *     we want therefore outranks our own client metadata, and we cannot
 *     prevent it from being *asked for*. We can refuse to *keep* it. Every
 *     token is checked against `allowedScopes` before it touches disk, and a
 *     token carrying a scope we did not sanction is rejected loudly with the
 *     offending scope named. This is the only enforcement point that cannot
 *     be overridden from the far side of the connection.
 *
 *  2. FAIL-CLOSED FILE HANDLING. A token file that can move money is treated
 *     like a private key: written atomically (temp + rename, so a concurrent
 *     reader sees old-or-new and never a truncated file), created at mode
 *     600, and REFUSED on read if group or other has any access. A
 *     world-readable token is not a warning -- it is a hard stop.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
// OAuthClientProvider and OAuthDiscoveryState are declared in the CLIENT auth
// module, not the shared one -- the provider contract is a client concern.
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientConfig } from '../types.js'

/** File mode we insist on: owner read/write only. */
const TOKEN_FILE_MODE = 0o600
/** Bytes of randomness in the temp-file suffix: 12 hex chars, ample to avoid
 * a collision between two concurrent writers. */
const TEMP_SUFFIX_BYTES = 6
/** Bytes of randomness in an OAuth state value (128 bits). */
const STATE_BYTES = 16

/**
 * Bits that must be absent for a token file to be considered private.
 * Checking explicitly rather than comparing to 0o600 lets a user tighten to
 * 0o400 (read-only) and still pass, which is a legitimate posture.
 */
const FORBIDDEN_MODE_BITS = 0o077
/** Permission bits, named so the diagnostic message reads as intent. */
const PERMISSION_BITS = 0o777
/** Radix for rendering an octal file mode back to a human. */
const OCTAL_RADIX = 8

/** On-disk shape. Every slot is optional so a partial file is surviveable. */
type StoredState = {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
  /**
   * The OAuth `state` parameter we generated for the in-flight authorization
   * request. Stored so the `login` command can verify the value that comes
   * back: the SDK generates a state when the provider supplies one but does
   * NOT compare it on return, so CSRF validation is ours to perform.
   */
  oauthState?: string
}

/** Raised when a granted scope is outside the allowlist, or when the token
 * file is readable by anyone but its owner. Both are fail-closed conditions:
 * the operation stops and nothing is written. */
export class OAuthCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthCredentialError'
  }
}

/**
 * Split an RFC 6749 scope string into its members.
 *
 * The spec defines scope as space-delimited; empty and whitespace-only members
 * are dropped so a trailing space cannot look like an empty scope that fails
 * an allowlist check for no reason.
 */
export const parseScope = (scope: string | undefined): string[] => {
  if (!scope) {
    return []
  }
  return scope
    .split(' ')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

/**
 * Return the scopes that are NOT permitted, preserving order and de-duplicating.
 * An empty array means the grant is acceptable.
 */
export const findDisallowedScopes = (
  granted: readonly string[],
  allowed: readonly string[]
): string[] => {
  const allow = new Set(allowed)
  const bad: string[] = []
  for (const s of granted) {
    if (!allow.has(s) && !bad.includes(s)) {
      bad.push(s)
    }
  }
  return bad
}

/**
 * Read the state file, enforcing the mode check.
 *
 * A missing file is NOT an error -- it is the ordinary first run, before any
 * token has been obtained. An unreadable or malformed file is an error,
 * because silently treating corruption as "no tokens" would start a new
 * authorization flow over the top of data the user may need to inspect.
 */
export const readState = async (tokenFile: string): Promise<StoredState> => {
  let stat
  try {
    stat = await fs.stat(tokenFile)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw err
  }

  const forbidden = stat.mode & FORBIDDEN_MODE_BITS
  if (forbidden !== 0) {
    throw new OAuthCredentialError(
      `Refusing to read '${tokenFile}': mode ${(stat.mode & PERMISSION_BITS).toString(OCTAL_RADIX)} grants access to group or other. ` +
        `This file can hold a token that authorizes real actions. Run: chmod 600 '${tokenFile}'`
    )
  }

  const raw = await fs.readFile(tokenFile, 'utf8')
  if (raw.trim() === '') {
    return {}
  }
  try {
    return JSON.parse(raw) as StoredState
  } catch {
    throw new OAuthCredentialError(
      `Refusing to use '${tokenFile}': it is not valid JSON. Inspect it rather than re-authorizing over it.`
    )
  }
}

/**
 * Write the state atomically.
 *
 * Temp-file-plus-rename in the SAME directory: rename is atomic within a
 * filesystem, so a concurrent reader observes either the previous complete
 * file or the new complete file. Writing in place would expose a window where
 * the file is truncated, which for a token file means a crash could cost the
 * refresh token entirely.
 */
export const writeState = async (
  tokenFile: string,
  state: StoredState
): Promise<void> => {
  const dir = path.dirname(tokenFile)
  await fs.mkdir(dir, { recursive: true })

  // Random suffix so two concurrent writers cannot collide on the temp name.
  const tmp = path.join(
    dir,
    `.${path.basename(tokenFile)}.${randomBytes(TEMP_SUFFIX_BYTES).toString('hex')}.tmp`
  )
  const body = JSON.stringify(state, null, 2)

  // 0o600 in the open() call means the file is never briefly world-readable
  // between creation and chmod, which chmod-after-write would allow.
  const handle = await fs.open(tmp, 'w', TOKEN_FILE_MODE)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, tokenFile)
}

/**
 * Default surface for an authorization URL when the caller supplies none.
 *
 * This is NOT dead code in server mode. When the aggregator boots without
 * tokens, `auth()` calls `redirectToAuthorization` and then returns
 * 'REDIRECT'; the transport throws and the aggregator's `allSettled` records
 * that child as unavailable. Logging the URL here is what turns an opaque
 * "child did not start" into an actionable journal line.
 */
const defaultRedirectSink = (url: URL): void => {
  console.error(
    '[oauth] Authorization required. Open this URL in a browser on THIS machine ' +
      '(the redirect target is loopback, so it must be the same host):\n' +
      `[oauth] ${url.toString()}`
  )
}

/**
 * Build the fetch used for OAuth HTTP calls.
 *
 * Some resource servers front their metadata endpoints with a WAF that rejects
 * library-default user agents with a bare 403. That failure is indistinguishable
 * from a broken server unless you know to look at the UA, so we set one
 * explicitly and let it be overridden from config.
 */
export const createUserAgentFetch =
  (userAgent: string): typeof fetch =>
  (input, init) => {
    const headers = new Headers(init?.headers)
    // Undici permits setting User-Agent; if a future runtime refused it we
    // would rather still make the call than throw on an optional nicety.
    try {
      headers.set('User-Agent', userAgent)
    } catch {
      /* keep the default agent rather than fail the request */
    }
    return fetch(input, { ...init, headers })
  }

/**
 * The provider itself.
 *
 * Exported as a factory rather than a class so the redirect sink and the
 * token-file path are both injected -- which is what makes it testable
 * without touching the network or the real filesystem.
 */
export type OAuthProviderOptions = Readonly<{
  config: OAuthClientConfig
  /** Where an authorization URL should be surfaced. Overridden in tests. */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>
}>

export const createOAuthProvider = (
  options: OAuthProviderOptions
): OAuthClientProvider => {
  const { config } = options
  const sink = options.onAuthorizationUrl ?? defaultRedirectSink

  const commit = async (
    mutate: (state: StoredState) => StoredState
  ): Promise<void> => {
    // Read-modify-write on every mutation. The file is small and infrequently
    // touched, so the extra read costs nothing and keeps each slot independent:
    // saving tokens can never clobber a code verifier saved moments earlier.
    const current = await readState(config.tokenFile)
    await writeState(config.tokenFile, mutate(current))
  }

  const provider: OAuthClientProvider = {
    get redirectUrl(): string {
      return config.redirectUrl
    },

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [config.redirectUrl],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: config.clientName ?? 'mcp-ai',
        // Requested scope. Note this is THIRD in the SDK's precedence order, so
        // it shapes the common path but cannot overrule a server that
        // advertises more -- saveTokens() is what actually bounds us.
        scope: config.scopes.join(' '),
      }
    },

    clientMetadataUrl: config.clientMetadataUrl,

    async clientInformation(): Promise<
      OAuthClientInformationMixed | undefined
    > {
      const state = await readState(config.tokenFile)
      return state.clientInformation
    },

    saveClientInformation(
      clientInformation: OAuthClientInformationMixed
    ): Promise<void> {
      return commit(state => ({ ...state, clientInformation }))
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const state = await readState(config.tokenFile)
      return state.tokens
    },

    saveTokens(tokens: OAuthTokens): Promise<void> {
      // The whole point of this module. See the module header, point 1.
      //
      // A refresh response may omit `scope`; when it does we validate against
      // the scope we already accepted, so a silent refresh cannot widen the
      // grant either.
      const effective = tokens.scope ? parseScope(tokens.scope) : undefined

      const check = async (): Promise<void> => {
        let granted = effective
        if (granted === undefined) {
          const existing = await readState(config.tokenFile)
          granted = parseScope(existing.tokens?.scope)
        }
        const disallowed = findDisallowedScopes(granted, config.allowedScopes)
        if (disallowed.length > 0) {
          // Name the FULL granted set, not only the offenders. When a provider
          // returns more than was requested, the useful question is "did it
          // return everything it advertises, or only the extras?" -- and the
          // offender list alone cannot answer that. Scopes are not secret; the
          // token is, and it is never logged.
          console.error(
            `[oauth] granted scope set (${granted.length}): ${granted.join(' ')}`
          )
          console.error(
            `[oauth] requested scope set (${config.scopes.length}): ${config.scopes.join(' ')}`
          )
          throw new OAuthCredentialError(
            `Refusing to persist OAuth tokens for '${config.tokenFile}': the grant includes scope(s) outside the allowlist: ` +
              `${disallowed.join(', ')}. Nothing was written. Either remove them from the authorization request or add them ` +
              `to allowedScopes if they are genuinely intended.`
          )
        }
      }

      return check().then(() => commit(state => ({ ...state, tokens })))
    },

    redirectToAuthorization(authorizationUrl: URL): void | Promise<void> {
      return sink(authorizationUrl)
    },

    saveCodeVerifier(codeVerifier: string): Promise<void> {
      return commit(state => ({ ...state, codeVerifier }))
    },

    async codeVerifier(): Promise<string> {
      const state = await readState(config.tokenFile)
      if (!state.codeVerifier) {
        throw new OAuthCredentialError(
          `No PKCE code verifier stored in '${config.tokenFile}'. Begin the flow with the 'login' command ` +
            `rather than retrying the connection, so the verifier and the authorization request are created together.`
        )
      }
      return state.codeVerifier
    },

    saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
      return commit(s => ({ ...s, discoveryState: state }))
    },

    async state(): Promise<string> {
      // A fresh value per authorization attempt, persisted before the browser
      // leaves so the return trip can be compared against it.
      const value = randomBytes(STATE_BYTES).toString('hex')
      await commit(s => ({ ...s, oauthState: value }))
      return value
    },
  }

  // discoveryState and invalidateCredentials are OPTIONAL members of the
  // contract, so they are attached here rather than inline. Required members
  // live in the literal above -- a required member assigned afterwards would
  // be a lie about the interface.
  provider.discoveryState = async (): Promise<
    OAuthDiscoveryState | undefined
  > => {
    const state = await readState(config.tokenFile)
    return state.discoveryState
  }

  provider.invalidateCredentials = async (
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'
  ): Promise<void> => {
    // Called by the SDK when the server says a credential is no longer valid.
    // Narrow on purpose: 'tokens' must not also discard client registration,
    // or the next attempt re-registers for no reason and loses discovery.
    await commit(state => {
      switch (scope) {
        case 'all':
          return {}
        case 'tokens':
          return { ...state, tokens: undefined }
        case 'client':
          return { ...state, clientInformation: undefined }
        case 'verifier':
          // The state value and the verifier are created together for one
          // attempt, so they are discarded together.
          return { ...state, codeVerifier: undefined, oauthState: undefined }
        case 'discovery':
          return { ...state, discoveryState: undefined }
        default:
          // Unreachable by type, but returning state keeps the reducer total:
          // a future scope value invalidates nothing rather than dropping
          // every credential the file holds.
          return state
      }
    })
  }

  return provider
}
