import express from 'express'
import cors from 'cors'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'

import {
  McpClientConfigs,
  McpAggregatorSseConfig,
  ExpressOptions,
} from '../../common/types.js'
import { create as createFeatures } from '../features.js'
import { openApiToZodSchema } from '../../common/libs.js'

const HTTP_ERROR = 500
const BAD_REQUEST = 400
const NOT_FOUND_STATUS = 404
const DEFAULT_PORT = 3000

const create = (config: McpAggregatorSseConfig, options?: ExpressOptions) => {
  let server: McpServer | undefined
  const transports: Record<string, SSEServerTransport> = {}
  const app = express()
  app.use(express.json())
  app.use(cors())

  options?.preRouteMiddleware?.forEach(middleware => app.use(middleware))

  const handleSseConnection = async (res: express.Response) => {
    try {
      const transport = new SSEServerTransport('/messages', res)
      const sessionId = transport.sessionId

      transports[sessionId] = transport

      transport.onclose = () => {
        delete transports[sessionId]
      }

      if (server) {
        await server.connect(transport)
      }

      return sessionId
    } catch {
      if (!res.headersSent) {
        res.status(HTTP_ERROR).send('Error establishing SSE stream')
      }
      throw new Error('Failed to establish SSE connection')
    }
  }

  const handlePostMessage = async (
    req: express.Request,
    res: express.Response
  ) => {
    const sessionId = req.query.sessionId
    if (!sessionId || typeof sessionId !== 'string') {
      res.status(BAD_REQUEST).send('Missing sessionId parameter')
      return
    }

    const transport = transports[sessionId]
    if (!transport) {
      res.status(NOT_FOUND_STATUS).send('Session not found')
      return
    }

    try {
      await transport.handlePostMessage(req, res, req.body)
    } catch {
      if (!res.headersSent) {
        res.status(HTTP_ERROR).send('Error handling request')
      }
    }
  }

  const setupServer = async (features: any) => {
    const rawTools = await features.getTools()
    const tools = rawTools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      parameters: tool.inputSchema,
    }))

    server = new McpServer(
      Object.assign({}, McpClientConfigs.aggregator, {
        capabilities: { tools },
      })
    )

    tools.forEach(tool => {
      const schema = openApiToZodSchema(tool.parameters)
      // @ts-ignore
      server.tool(tool.name, tool.description || '', schema, async extra => {
        const results = await features.executeTool(tool.name, extra)
        return results as any
      })
    })
  }

  return {
    // Port resolution matches the aggregator http entry (config-first with
    // DEFAULT_PORT fallback): connection.port is the declared contract on
    // SseServerConfig.connection — previously this entry ignored it and
    // always listened on DEFAULT_PORT unless a caller passed an argument
    // (the sole caller, bin/mcp-aggregator.mts, never did).
    start: async () => {
      const features = await createFeatures(config)
      await features.connect()
      await setupServer(features)

      const path = config.server.path || '/'
      const messagesPath = config.server.messagesPath || '/messages'

      options?.additionalRoutes?.forEach(route => {
        app[route.method](route.path, route.handler)
      })

      app.get(path, async (req, res) => {
        try {
          await handleSseConnection(res)
        } catch {
          // Error already handled in handleSseConnection
        }
      })

      app.post(messagesPath, handlePostMessage)
      // Add catch-all route for non-existent URLs
      app.use((req, res) => {
        res.status(NOT_FOUND_STATUS).json({
          error: 'Not Found',
          message: `The requested URL ${req.url} was not found on this server`,
          status: NOT_FOUND_STATUS,
        })
      })

      // Bind to the configured interface when connection.host is set
      // (e.g. '127.0.0.1' for loopback-only); Node's default (all
      // interfaces) applies when omitted. Returns the underlying server
      // so callers/tests can inspect the actual bind via server.address().
      const listenPort = config.server.connection.port || DEFAULT_PORT
      const httpServer = app.listen(listenPort, config.server.connection.host)
      return httpServer
    },
    stop: async () => {
      await Promise.all(
        Object.values(transports).map(transport => transport.close())
      )
      await server?.close()
    },
    set: (key: string, value: any) => {
      app.set(key, value)
    },
  }
}

export { create }
