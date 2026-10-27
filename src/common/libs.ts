import { z, ZodSchema, ZodType } from 'zod'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

import { Connection } from './types.js'
import { createOAuthProvider, createUserAgentFetch } from './oauth/provider.js'

/**
 * Optional collaborators for `toMcpConfig`, injected so the function stays a
 * pure mapping from config to transport options and can be tested without
 * touching the network or the filesystem.
 */
export type TransportOptionsOverrides = Readonly<{
  /**
   * Where an authorization URL should be surfaced. The aggregator passes a
   * journal logger; the `login` command passes its own printer.
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>
}>

export const toMcpConfig = (
  connection: Connection,
  overrides: TransportOptionsOverrides = {}
): StreamableHTTPClientTransportOptions => {
  if (connection.type === 'http') {
    // OAuth is built here rather than inside createTransport so that the
    // options object stays a single, inspectable value -- and so an http
    // connection WITHOUT oauth produces exactly the same object it always
    // did, down to the absence of the authProvider key.
    const authProvider = connection.oauth
      ? createOAuthProvider({
          config: connection.oauth,
          onAuthorizationUrl: overrides.onAuthorizationUrl,
        })
      : undefined

    const fetchImpl =
      connection.oauth?.userAgent !== undefined
        ? createUserAgentFetch(connection.oauth.userAgent)
        : undefined

    return {
      requestInit: {
        headers: connection.headers,
        signal: connection.timeout
          ? AbortSignal.timeout(connection.timeout)
          : undefined,
      },
      reconnectionOptions: connection.retry
        ? {
            maxReconnectionDelay: connection.retry.backoff,
            initialReconnectionDelay: 1000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: connection.retry.attempts,
          }
        : undefined,
      authProvider,
      fetch: fetchImpl,
    }
  }
  throw new Error(`Unsupported connection type: ${connection.type}`)
}

export const createTransport = (
  connection: Connection,
  overrides: TransportOptionsOverrides = {}
) => {
  if (connection.type === 'http') {
    // The options object was previously discarded, so `connection.headers` was
    // silently dropped and no auth provider could ever be supplied. Both are
    // now honored through the same mapping used everywhere else.
    return new StreamableHTTPClientTransport(
      new URL(connection.url),
      toMcpConfig(connection, overrides)
    )
  }
  if (connection.type === 'ws') {
    return new WebSocketClientTransport(new URL(connection.url))
  }
  if (connection.type === 'cli') {
    return new StdioClientTransport({
      command: connection.path,
      args: connection.args,
      env: connection.env,
      cwd: connection.cwd,
    })
  }
  if (connection.type === 'sse') {
    return new SSEClientTransport(new URL(connection.url))
  }
  throw new Error(
    `Unsupported connection type: ${(connection as { type: string }).type}`
  )
}

/**
 * Defensive preprocessor for Zod schemas.
 * Some MCP clients (like Kai) stringify arrays in JSON-RPC requests.
 * This creates a pre-processor that attempts to parse stringified JSON before validation.
 */
const createStringifiedPreprocessor = (innerType: ZodType): ZodType => {
  return z.preprocess(val => {
    // If it's a string, try to parse it as JSON
    if (typeof val === 'string') {
      // eslint-disable-next-line functional/no-try-statements
      try {
        return JSON.parse(val)
      } catch {
        return val // Return as-is if not valid JSON
      }
    }
    return val // Return as-is if not a string
  }, innerType) as unknown as ZodType
}

export const openApiToZodSchema = (
  parameters: any
): Record<string, ZodType> => {
  const { properties, required } = parameters

  if (!properties) {
    return {}
  }

  return Object.entries(properties).reduce(
    (acc, [key, propDef]: [string, any]) => {
      // Create the Zod field and apply optional if needed
      const zodField = createZodTypeFromDefinition(propDef)
      const finalField = !required?.includes(key)
        ? zodField.optional()
        : zodField

      // Return new accumulated object with this field
      return { ...acc, [key]: finalField }
    },
    {}
  )
}

// Break complex handling into small helpers to satisfy lint rules
const buildUnionFromArray = (arr: any[]) => {
  const members = arr.map(createZodTypeFromDefinition)
  if (members.length === 1) {
    return members[0]
  }
  return z.union(
    members as unknown as [any, any, ...any[]]
  ) as unknown as ZodType
}

const buildIntersectionFromArray = (arr: any[]) => {
  if (arr.length === 0) {
    return z.any()
  }
  return arr
    .map(createZodTypeFromDefinition)
    .reduce((acc, member) => z.intersection(acc as any, member as any))
}

const createEnumOrLiterals = (
  enumValues: any[] | undefined,
  preferredType: 'string' | 'number' | 'boolean' | null
) => {
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    return null
  }
  if (
    preferredType === 'string' &&
    enumValues.every(v => typeof v === 'string')
  ) {
    return z.enum(enumValues as [string, ...string[]]) as ZodType
  }
  const literals = enumValues.map((v: unknown) => z.literal(v as any))
  if (literals.length === 1) {
    return literals[0]
  }
  return z.union(
    literals as unknown as [any, any, ...any[]]
  ) as unknown as ZodType
}

// Single function to handle all types of definitions
const createZodTypeFromDefinition = (def: any): ZodType => {
  if (!def || typeof def !== 'object') {
    return z.any()
  }

  const {
    type,
    items,
    nullable,
    anyOf,
    oneOf,
    allOf,
    enum: enumValues,
    format,
  } = def

  // Handle combinators first
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    return buildUnionFromArray(anyOf)
  }
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    return buildUnionFromArray(oneOf)
  }
  if (Array.isArray(allOf) && allOf.length > 0) {
    return buildIntersectionFromArray(allOf)
  }

  // Compute by base type
  const zodType: ZodType = (() => {
    switch (type) {
      case 'string': {
        const enumType = createEnumOrLiterals(enumValues, 'string')
        const base = enumType ?? z.string()
        if (format === 'date-time' && (base as any).datetime) {
          return (base as any).datetime()
        }
        return base
      }
      case 'number':
      case 'integer': {
        const enumType = createEnumOrLiterals(enumValues, 'number')
        return enumType ?? z.number()
      }
      case 'boolean': {
        const enumType = createEnumOrLiterals(enumValues, 'boolean')
        return enumType ?? z.boolean()
      }
      case 'array': {
        // Wrap arrays with stringified JSON preprocessor to handle Kai's serialization
        const innerArray = z.array(
          items ? createZodTypeFromDefinition(items) : z.any()
        )
        return createStringifiedPreprocessor(innerArray)
      }
      case 'object': {
        // Wrap objects with stringified JSON preprocessor to handle Kai's serialization
        const innerObject = z.object(openApiToZodSchema(def)).passthrough()
        return createStringifiedPreprocessor(innerObject)
      }
      default: {
        const enumType = createEnumOrLiterals(enumValues, null)
        return enumType ?? z.any()
      }
    }
  })()

  if (nullable) {
    return zodType.nullable()
  }
  return zodType
}

/**
 * Check if value is a Zod schema using instanceof.
 */
export const isZodSchema = (schema: any): schema is ZodSchema => {
  return schema instanceof ZodSchema
}

/**
 * Check if value is a raw shape (plain object with Zod validators).
 * Raw shapes don't have _def/_zod but their values do.
 */
const isZodTypeLike = (value: any): boolean => {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.parse === 'function' &&
    typeof value.safeParse === 'function'
  )
}

export const isZodRawShape = (schema: any): boolean => {
  if (!schema || typeof schema !== 'object') {
    return false
  }
  if (schema instanceof ZodSchema) {
    return false // Already a schema
  }
  const values = Object.values(schema)
  return values.length > 0 && values.every(isZodTypeLike)
}

/**
 * Wrap a raw shape into a Zod object schema.
 */
export const wrapRawShape = (shape: any): ZodSchema => {
  return z.object(shape)
}
