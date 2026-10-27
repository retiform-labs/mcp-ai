import express from 'express'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js'
import { ZodSchema } from 'zod'

/**
 * A value that can be serialized to JSON
 */
export type JsonAble =
  | string
  | number
  | boolean
  | null
  | JsonAble[]
  | { [key: string]: JsonAble }

/**
 * Base configuration for an MCP instance
 */
export type McpConfig = Readonly<{
  transport: Transport
  capabilities?: ClientCapabilities
}>

/**
 * Supported AI providers
 */
export enum Provider {
  Claude = 'claude',
  OpenAI = 'openai',
  AwsBedrockClaude = 'aws-bedrock-claude',
}
type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never }

export type XOR<T, U> = T | U extends object
  ? (Without<T, U> & U) | (Without<U, T> & T)
  : T | U

/**
 * Definition of an MCP tool
 */
export type McpTool = Readonly<{
  name: string
  description: string
  inputSchema: XOR<OpenAPISchema, ZodSchema>
  outputSchema?: XOR<OpenAPISchema, ZodSchema>
}>

/**
 * CLI connection configuration
 */
export type CliConnection = Readonly<{
  type: 'cli'
  path: string
  args?: string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
}>

/**
 * SSE connection configuration
 */
export type SseConnection = Readonly<{
  type: 'sse'
  url: string
}>

/**
 * HTTP connection configuration
 */
export type HttpConnection = Readonly<{
  type: 'http'
  url: string
  headers?: Readonly<Record<string, string>>
  /**
   * OAuth 2.1 client credentials for this connection. When present, the
   * transport obtains a token (interactively, via `login`, or silently via a
   * saved refresh token) and presents it as a Bearer credential. Absent, the
   * connection behaves exactly as before.
   */
  oauth?: OAuthClientConfig
  timeout?: number
  retry?: Readonly<{
    attempts: number
    backoff: number
  }>
}>

/**
 * WebSocket connection configuration
 */
export type WsConnection = Readonly<{
  type: 'ws'
  url: string
  protocols?: Readonly<string[]>
  headers?: Readonly<Record<string, string>>
  reconnect?: Readonly<{
    attempts: number
    backoff: number
  }>
}>

/**
 * Union type of all possible connection types
 */
export type Connection =
  | CliConnection
  | HttpConnection
  | WsConnection
  | SseConnection

/**
 * MCP Integrator configuration
 */
export type McpIntegratorConfig = Readonly<{
  connection: Connection
  provider: Provider
  model?: string
  modelId?: string
  includeListToolsTool?: boolean
  maxParallelCalls?: number
}>

/**
 * HTTP server configuration
 */
export type HttpServerConfig = Readonly<{
  connection: Readonly<{
    type: 'http'
    url: string
    port?: number
    /**
     * Interface address for the server to listen on (e.g. '127.0.0.1' for
     * loopback-only). Passed as the second argument to express's
     * `app.listen(port, host)`. When omitted, Node binds all interfaces
     * (default `::`), preserving pre-1.6.7 behavior.
     */
    host?: string
    headers?: Readonly<Record<string, string>>
    /**
     * Server-side authentication. When declared, every non-OPTIONS request
     * must present the API key (Authorization: Bearer or x-api-key) or
     * receive 401 + WWW-Authenticate: Bearer. The secret itself is NEVER a
     * config value: it is read from the environment at startup (env names
     * the variable, default MCP_API_KEY) and a missing secret refuses to
     * boot (fail-closed).
     */
    auth?: BearerAuthConfig
    timeout?: number
    retry?: Readonly<{
      attempts: number
      backoff: number
    }>
  }>
  /** Path to handle MCP requests. Defaults to '/' */
  path?: string
}>

/**
 * WebSocket server configuration
 */
export type WsServerConfig = Readonly<{
  connection: WsConnection
}>

/**
 * CLI server configuration
 */
export type CliServerConfig = Readonly<{
  connection: {
    type: 'cli'
  }
}>

/**
 * SSE server configuration
 */
export type SseServerConfig = Readonly<{
  connection: Readonly<{
    type: 'sse'
    url: string
    port?: number
    /**
     * Interface address for the server to listen on (e.g. '127.0.0.1' for
     * loopback-only). Passed as the second argument to express's
     * `app.listen(port, host)`. When omitted, Node binds all interfaces
     * (default `::`), preserving pre-1.6.7 behavior.
     */
    host?: string
    /**
     * Server-side authentication (same contract as the HTTP connection:
     * config declares, environment supplies, fail-closed at startup).
     */
    auth?: BearerAuthConfig
  }>
  /** Path to establish SSE connection. Defaults to '/' */
  path?: string
  /** Path to handle SSE messages. Defaults to '/messages' */
  messagesPath?: string
}>

/**
 * Union type of all possible server configurations
 */
export type ServerConfig =
  | HttpServerConfig
  | WsServerConfig
  | CliServerConfig
  | SseServerConfig

/**
 * Base configuration for MCP Aggregator
 */
export type McpAggregatorConfigBase = Readonly<{
  mcps: Readonly<
    Readonly<{
      id: string
      connection: Connection
      prefix?: string
      /**
       * When true, this MCP server is skipped during connection.
       * Useful for temporarily disabling servers without removing config.
       * @default false (absence = active, backward compatible)
       */
      disabled?: boolean
    }>[]
  >
  maxParallelCalls?: number
  prefix?: string
  autoPrefix?: boolean
  toolTimeoutMs?: number // default: 180000 (3 minutes), raise/lower per environment
}>

/**
 * Configuration for an HTTP server
 */
export type ServerHttpConfig = Readonly<{
  server: HttpServerConfig
}>

/**
 * Configuration for a stateless HTTP server
 */
export type ServerStatelessHttpConfig = Readonly<{
  server: HttpServerConfig
  stateless: true
}>

/**
 * Configuration for a WebSocket server
 */
export type ServerWsConfig = Readonly<{
  server: WsServerConfig
}>

/**
 * Configuration for a CLI server
 */
export type ServerCliConfig = Readonly<{
  server: CliServerConfig
}>

/**
 * Configuration for a SSE server
 */
export type ServerSseConfig = Readonly<{
  server: SseServerConfig
}>

export type McpAggregatorHttpConfig = McpAggregatorConfigBase & ServerHttpConfig
export type McpAggregatorWsConfig = McpAggregatorConfigBase & ServerWsConfig
export type McpAggregatorCliConfig = McpAggregatorConfigBase & ServerCliConfig
export type McpAggregatorSseConfig = McpAggregatorConfigBase & ServerSseConfig

/**
 * Union type of all possible MCP Aggregator configurations
 */
export type McpAggregatorConfig =
  | McpAggregatorHttpConfig
  | McpAggregatorWsConfig
  | McpAggregatorCliConfig
  | McpAggregatorSseConfig

/**
 * Full configuration for both MCP Integrator and Aggregator
 */
export type McpIntegratorFullConfig = Readonly<{
  integrator: McpIntegratorConfig
  aggregator: McpAggregatorConfig
}>

/**
 * Current version of the MCP library
 */
export const LibraryVersion = '1.1.1'

/**
 * Default client configurations for MCP Integrator and Aggregator
 */
export const McpClientConfigs = {
  integrator: {
    name: 'mcp-integrator',
    version: LibraryVersion,
  },
  aggregator: {
    name: 'mcp-aggregator',
    version: LibraryVersion,
  },
} as const

/**
 * OpenAPI schema definition for tool parameters
 */
export type OpenAPISchema = Readonly<{
  type: 'object'
  properties: Readonly<
    Record<
      string,
      {
        type: string
        description?: string
        enum?: Readonly<string[]>
        /**
         * If true, the value can be null in addition to its type
         */
        nullable?: boolean
      }
    >
  >
  required?: Readonly<string[]>
}>

/**
 * Server-side bearer authentication declaration.
 *
 * Config DECLARES, the environment SUPPLIES: `env` names the environment
 * variable holding the API key (default `MCP_API_KEY`). The key value must
 * never appear in this config file (configs leak into backups, logs, and
 * version control). When `auth` is declared and the named environment
 * variable is unset/empty at startup, the server MUST refuse to boot —
 * fail-closed (see src/common/middleware/bearer-auth.ts).
 */
/**
 * OAuth 2.1 client configuration for an `http` connection.
 *
 * This is CLIENT-side: it is how we obtain and present a token to somebody
 * else's resource server. It is deliberately NOT named `auth` -- that key
 * already means something on `HttpServerConfig.connection` (the bearer token
 * WE require from inbound callers). Conflating the two would make a config
 * read as if it both demanded and submitted credentials.
 *
 * The flow itself (discovery, dynamic client registration, PKCE, code
 * exchange, refresh) is implemented by the MCP SDK's `OAuthClientProvider`
 * contract; this type only carries the decisions we are responsible for.
 *
 * `scopes` and `allowedScopes` are separate on purpose. `scopes` is what we
 * ASK for; `allowedScopes` is the most we will ever PERSIST. They usually
 * match, but the resource server controls the resolved request scope
 * (a server-advertised scope list outranks our client metadata), so the
 * allowlist is the only enforcement point that cannot be overridden from
 * the far side.
 */
export type OAuthClientConfig = Readonly<{
  /**
   * Absolute path to the JSON file holding tokens, client information, the
   * PKCE verifier and any discovery state. Written atomically and kept at
   * mode 600; a file readable by group or other is refused on read, because
   * it may hold a token that can move money.
   */
  tokenFile: string
  /**
   * Loopback redirect URI. Most providers (RFC 8252) accept only
   * `http://127.0.0.1:<port>/<path>`; a public or non-loopback URL is
   * rejected at the authorization endpoint.
   */
  redirectUrl: string
  /**
   * Scopes to REQUEST. Sent as the authorization request's `scope` and as the
   * client metadata `scope`.
   */
  scopes: readonly string[]
  /**
   * Scopes we are willing to STORE. A granted scope outside this list causes
   * `saveTokens()` to throw and persist nothing, so an over-broad grant can
   * never reach a request.
   */
  allowedScopes: readonly string[]
  /** Human-readable client name sent with dynamic client registration. */
  clientName?: string
  /**
   * User-Agent used for the OAuth HTTP calls. Some providers front their
   * metadata endpoints with a WAF that rejects obviously non-browser or
   * library-default agents; setting this avoids an opaque 403.
   */
  userAgent?: string
  /** Optional URL to fetch client metadata from, instead of inline metadata. */
  clientMetadataUrl?: string
}>

export type BearerAuthConfig = Readonly<{
  type: 'bearer'
  /** Environment variable holding the API key. Default: MCP_API_KEY. */
  env?: string
}>

export type ExpressRoute = Readonly<{
  path: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  handler: (req: express.Request, res: express.Response) => Promise<void>
}>

export type ExpressMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => Promise<void>

export type ExpressOptions = Readonly<{
  additionalRoutes?: ExpressRoute[]
  preRouteMiddleware?: ExpressMiddleware[]
  afterRouteCallback?: (
    req: express.Request,
    res: express.Response
  ) => Promise<void> | void
  limit?: string
  jsonBodyParser?: {
    limit?: string
    strict?: boolean
  }
}>
