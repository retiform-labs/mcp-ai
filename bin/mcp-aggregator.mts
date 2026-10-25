#!/usr/bin/env tsx

import { readFileSync } from 'fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { create } from '../src/aggregator/entries/index.ts'
import { buildExpressOptionsFromConfig } from '../src/common/middleware/auth-from-config.ts'

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
Usage: mcp-aggregator [options] <config-file>

Launches an MCP Aggregator server according to the configuration passed in.

Options:
  -h, --help     Show this help message
  -v, --version  Show version information

Arguments:
  config-file    Path to the configuration file (required)
`)
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
