#!/usr/bin/env tsx

import { readFileSync } from 'fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { create } from '../src/aggregator/entries/index.ts'
import { buildExpressOptionsFromConfig } from '../src/common/middleware/auth-from-config.ts'
import { login, loadAggregatorConfig } from '../src/common/oauth/login.ts'

/**
 * Resolve one child's oauth block from a config file and run the flow.
 *
 * Errors carry the config path and child id because a login failure with no
 * context is the expensive kind: it costs a consent and tells you nothing.
 */
async function runLogin(configPath, mcpId) {
  const { mcps } = loadAggregatorConfig(configPath)
  const entry = mcps.find((m) => m.id === mcpId)
  if (!entry) {
    throw new Error(
      `No MCP with id '${mcpId}' in '${configPath}'. Available: ${mcps.map((m) => m.id).join(', ')}`
    )
  }
  const connection = entry.connection
  if (connection.type !== 'http' || !connection.url) {
    throw new Error(`MCP '${mcpId}' is not an http connection; OAuth login does not apply to it.`)
  }
  if (!connection.oauth) {
    throw new Error(
      `MCP '${mcpId}' has no 'oauth' block on its connection. Add one (tokenFile, redirectUrl, scopes, allowedScopes) before running login.`
    )
  }

  const result = await login({ serverUrl: connection.url, config: connection.oauth })
  console.info(`Authorized. Tokens written to ${result.tokenFile}`)
  console.info(`Granted scope: ${result.grantedScope.join(' ') || '(none reported)'}`)
}

async function main() {
  try {
    const { values, positionals } = parseArgs({
      options: {
        help: {
          type: 'boolean',
          short: 'h',
        },
        version: {
          type: 'boolean',
          short: 'v',
        },
      },
      allowPositionals: true,
    })

    if (values.version) {
      // Resolve against this script's own location, never the caller's cwd:
      // a globally installed bin runs from an arbitrary directory, where
      // ./package.json reads an unrelated file (or throws). ../package.json is
      // correct in BOTH layouts - bin/ in the repo, and dist/bin/ once built
      // (build.sh copies package.json into dist/).
      const here = dirname(fileURLToPath(import.meta.url))
      const packageJson = JSON.parse(
        readFileSync(join(here, '..', 'package.json'), 'utf-8')
      )
      console.info(`mcp-aggregator v${packageJson.version}`)
      process.exit(0)
    }

    if (values.help || positionals.length === 0) {
      console.info(`
Usage: mcp-aggregator [options] <config-file>\n       mcp-aggregator login <config-file> <mcp-id>\n\nLaunches an MCP Aggregator server according to the configuration passed in.\n\nCommands:\n  login <config-file> <mcp-id>\n                 Run the OAuth authorization flow for one http child and\n                 store its tokens. The redirect target is loopback, so run\n                 this where the browser is. The server never waits for a\n                 human: children without tokens are simply unavailable.\n\nOptions:\n  -h, --help     Show this help message\n  -v, --version  Show version information\n\nArguments:\n  config-file    Path to the configuration file (required)\n`)
      process.exit(0)
    }

    // `login` is a subcommand, not a config file. Dispatch it before any
    // server setup so a login run can never accidentally boot a server.
    if (positionals[0] === 'login') {
      const configPath = positionals[1]
      const mcpId = positionals[2]
      if (!configPath || !mcpId) {
        console.error('Error: usage is: mcp-aggregator login <config-file> <mcp-id>')
        process.exit(1)
      }
      await runLogin(configPath, mcpId)
      process.exit(0)
    }

    // Get config file path
    const configPath = positionals[0]
    if (!configPath) {
      console.error('Error: Configuration file path is required')
      process.exit(1)
    }

    const fullConfig = JSON.parse(readFileSync(configPath, 'utf-8'))

    // Extract aggregator config - use the whole config if no aggregator property
    const config = fullConfig.aggregator ? fullConfig.aggregator : fullConfig

    // Resolve declared server auth at this composition seam: config
    // declares, the environment supplies (fail-closed — a declared auth
    // with an unresolvable secret exits here, never boots unauthenticated).
    // Passing undefined (no auth declared) preserves pre-auth behavior.
    const expressOptions = buildExpressOptionsFromConfig(config)
    const server = create(config, expressOptions ? { express: expressOptions } : undefined)

    // Handle process termination
    process.on('SIGINT', async () => {
      console.info('Shutting down...')
      await server.stop()
      process.exit(0)
    })

    // Start the server
    await server.start()
  } catch (error) {
    console.error(
      'Error:',
      error instanceof Error ? error.message : 'Unknown error occurred'
    )
    process.exit(1)
  }
}

main()
