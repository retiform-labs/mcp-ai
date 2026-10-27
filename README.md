# The MCP Aggregation and Integration Library

![Unit Tests](https://github.com/retiform-labs/mcp-ai/actions/workflows/ut.yml/badge.svg?branch=main)

MCP servers are a pretty sweet idea, but having the ability to integrate them all together into a system, or package them up and make them available, should be easier. This is where this library comes in.

## Installation

```bash
npm install @retiform/mcp-ai
```

## Tools

The following are the tools available in this library

- Aggregator: Aggregates multiple MCP servers under one configurable roof. Useful for translating supported protocols.
- Integrator: Easier integration of MCP servers directly into LLM providers.
- SimpleServer: Build a simple MCP configurable server, where you just provide tool descriptions and execution, it handles the rest. You can configure this to make the same server go from CLI to HTTP or SSE.

## Creating an Integrator

An integrator is a tool that helps connect an LLM to an MCP server (like the aggregator). It can be used to format tools for the LLM provider, extract tool calls from the LLM response, and execute tool calls.

```typescript
import { createIntegrator } from '@retiform/mcp-ai/integrator'
import { Provider } from '@retiform/mcp-ai'

// Create an integrator configuration
const config = {
  connection: {
    type: 'http',
    url: 'http://localhost:3000',
    headers: {
      'Content-Type': 'application/json',
    },
  },
  provider: Provider.OpenAI,
  model: 'gpt-4-turbo-preview',
  maxParallelCalls: 1,
}

// Initialize the integrator
const integrator = createIntegrator(config)

// Connect to the MCP server
await integrator.connect()

try {
  // Get available tools
  const tools = await integrator.getTools()

  // Format tools for the LLM provider
  const formattedTools = integrator.formatToolsForProvider(tools)

  // Example of using the integrator with an LLM
  const response = await llm.sendMessage('List available tools', formattedTools)

  // Extract tool calls from the LLM response
  const toolCalls = integrator.extractToolCalls(response)

  // Execute the tool calls
  const results = await integrator.executeToolCalls(toolCalls)

  // Create a new request with the tool results
  const newRequest = integrator.createToolResponseRequest(
    originalRequest,
    response,
    results
  )
} finally {
  // Always disconnect when done
  await integrator.disconnect()
}
```

## Creating an Aggregator

An aggregator is a MCP server that can aggregate multiple MCP servers into one. This can provide a single interface for AI to access multiple MCPs.
This can also be useful for adapting one type of MCP server to another. For example, if Cursor doesn't support http, you can support an http aggregator by putting a SSE aggregator in front.

```typescript
import { create } from '@retiform/mcp-ai/aggregator'

// Create an aggregator configuration
const config = {
  server: {
    connection: {
      type: 'http',
      url: 'http://localhost:3000',
      port: 3000,
    },
    maxParallelCalls: 10,
  },
  mcps: [
    {
      id: 'filesystem',
      connection: {
        type: 'cli',
        path: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
    },
    {
      id: 'memory',
      connection: {
        type: 'cli',
        path: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
      },
    },
  ],
}

// Create and start the aggregator server
const server = create(config)

// Start the server
await server.start()

// The server will now be available at http://localhost:3000
// It will aggregate the tools from both the filesystem and memory MCPs

// When done, stop the server
await server.stop()
```

## Creating a Simple Server

A SimpleServer is a configurable MCP server that can be easily adapted to different protocols (HTTP, SSE, CLI) while maintaining the same tool functionality. This makes it perfect for building custom MCP servers that can be deployed in different environments.

```typescript
import { create } from '@retiform/mcp-ai/simple-server'

// Create a simple server configuration
const config = {
  name: 'my-mcp-server',
  version: '1.0.0',
  tools: [
    {
      name: 'echo',
      description: 'Echoes back the input',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
      execute: async (input: { message: string }) => {
        return { echo: input.message }
      },
    },
  ],
  server: {
    connection: {
      type: 'http',
      port: 3000,
    },
  },
}

// Create and start the server
const server = create(config)
await server.start()

// The server will now be available at http://localhost:3000
// It will expose the echo tool and handle all MCP protocol details

// When done, stop the server
await server.stop()
```

### Simple Server Configuration Examples

#### HTTP Server

```json
{
  "name": "my-mcp-server",
  "version": "1.0.0",
  "tools": [
    {
      "name": "echo",
      "description": "Echoes back the input",
      "inputSchema": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"]
      }
    }
  ],
  "server": {
    "connection": {
      "type": "http",
      "port": 3000
    }
  }
}
```

#### SSE Server

```json
{
  "name": "my-mcp-server",
  "version": "1.0.0",
  "tools": [
    {
      "name": "echo",
      "description": "Echoes back the input",
      "inputSchema": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"]
      }
    }
  ],
  "server": {
    "connection": {
      "type": "sse",
      "port": 3000
    },
    "path": "/",
    "messagesPath": "/messages"
  }
}
```

#### CLI Server

```json
{
  "name": "my-mcp-server",
  "version": "1.0.0",
  "tools": [
    {
      "name": "echo",
      "description": "Echoes back the input",
      "inputSchema": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"]
      }
    }
  ],
  "server": {
    "connection": {
      "type": "cli"
    }
  }
}
```

The SimpleServer makes it easy to:

- Define your tools once and deploy them in different environments
- Switch between protocols by just changing the configuration
- Focus on your tool logic while the server handles MCP protocol details
- Maintain consistent behavior across different transport mechanisms

## Tool Namespace Prefixing

When aggregating multiple MCP servers, you will often encounter **tool name
collisions**: two different servers expose a tool with the same name (e.g., both
have a `list_files` or `search` tool). Without prefixing, only one tool
would be visible — the second silently overwrites the first. This library adds
**automatic and configurable namespace prefixing** to solve that problem
gracefully.

### Why This Matters

Real-world example: You aggregate a filesystem MCP
(`@modelcontextprotocol/server-filesystem`) and a memory MCP
(`@modelcontextprotocol/server-memory`). Both expose a `search` tool. Without
prefixing, `aggregator.getTools()` returns one `search` and drops the
other. With `autoPrefix: true`, you get:

- `filesystem_search`
- `memory_search`

Each tool remains individually callable. No data is lost. No ambiguity for the
LLM.

### Three Levels of Prefixing

| Level                     | Source                    | Description                                | Example result |
| ------------------------- | ------------------------- | ------------------------------------------ | -------------- |
| **Aggregator-level**      | `config.prefix`           | Prefix applied to _all_ tools              | `prod_`        |
| **MCP-level (explicit)**  | `mcp.prefix`              | Overrides auto-derived prefix for that MCP | `mem_`         |
| **MCP-level (automatic)** | `config.autoPrefix: true` | Derived from `mcp.id + "_"`                | `filesystem_`  |

Prefixes compose left-to-right: `{aggregatorPrefix}{mcpPrefix}{toolName}`

### Configuration Example

```json
{
  "aggregator": {
    "server": {
      "connection": { "type": "http", "port": 3000 },
      "maxParallelCalls": 10,
      "prefix": "prod_"
    },
    "autoPrefix": true,
    "mcps": [
      {
        "id": "filesystem",
        "connection": {
          "type": "cli",
          "path": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
        }
      },
      {
        "id": "memory",
        "prefix": "mem_",
        "connection": {
          "type": "cli",
          "path": "npx",
          "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
      }
    ]
  }
}
```

With the configuration above:

- Filesystem tools: `prod_filesystem_listFiles`,
  `prod_filesystem_readFile`, etc.
- Memory tools: `prod_mem_listNotes`, `prod_mem_search`, etc.

The aggregator-level `prod_` prefix is applied to every tool. The filesystem
MCP gets its `id` as prefix because no explicit `prefix` is set. The memory
MCP uses its explicit `mcp.prefix` override `mem_` instead of `memory_`.

### Collision Resolution

If two tools _still_ produce the same final name (e.g., two MCPs both configured
with `prefix: "db_"`), the second tool is automatically renamed with a numeric
suffix and a console warning is emitted:

```
Tool name collision: "search" from MCP "db2" would conflict. Renamed to "db_search_2".
```

Collision resolution runs in the order MCPs are declared, giving you explicit
control via ordering.

### Using It in Code

```typescript
import { create } from '@retiform/mcp-ai/aggregator'

const config = {
  server: { connection: { type: 'http', port: 3000 } },
  prefix: 'prod_',
  autoPrefix: true,
  mcps: [
    {
      id: 'filesystem',
      connection: {
        /* ... */
      },
    },
    {
      id: 'memory',
      prefix: 'mem_',
      connection: {
        /* ... */
      },
    },
  ],
}

const server = create(config)
await server.start()

const tools = await server.getTools()
// tools contains all uniquely-named tools from both MCPs
```

Available since `1.6.1`.

## Disabling MCP Servers

Sometimes you need to temporarily disable an MCP server without removing its
configuration — for debugging, maintenance, or when a server is known to be
down. The `disabled` flag lets you do this:

```json
{
  "mcps": [
    {
      "id": "filesystem",
      "connection": {
        "type": "cli",
        "path": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
      }
    },
    {
      "id": "memory",
      "disabled": true,
      "connection": {
        "type": "cli",
        "path": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"]
      }
    }
  ]
}
```

When `disabled: true`, the MCP server is skipped entirely during connection.
No client is spawned, no tools are collected, and no errors are raised.
The server is logged as skipped via `console.info`.

- `disabled: true` → server is skipped
- `disabled: false` → server is active (same as omitting the field)
- `disabled: undefined` → server is active (backward compatible)

Available since `1.6.6`.

## Per-Tool Filtering

An MCP server can expose a hundred tools when you want three. `allowTools` and
`denyTools` narrow what one server contributes to the aggregated roster:

```json
{
  "mcps": [
    {
      "id": "bank",
      "allowTools": ["get_balance", "list_transactions", "get_account"],
      "connection": {
        "type": "http",
        "url": "https://mcp.example.com",
        "oauth": {
          "tokenFile": "~/.mcp/oauth/bank.json",
          "redirectUrl": "http://127.0.0.1:8899/cb",
          "scopes": ["accounts:read"],
          "allowedScopes": ["accounts:read"]
        }
      }
    },
    {
      "id": "browser",
      "denyTools": ["evaluate_js", "upload_file"],
      "connection": {
        "type": "cli",
        "path": "npx",
        "args": ["-y", "browser-mcp"]
      }
    }
  ]
}
```

### Semantics

| Configuration              | Result                                                    |
| -------------------------- | --------------------------------------------------------- |
| neither field              | every tool from that server, exactly as before            |
| `allowTools: ["a"]`        | only `a`                                                  |
| `denyTools: ["a"]`         | everything except `a`                                     |
| both, naming the same tool | **denied** — deny wins                                    |
| `allowTools: []`           | **nothing** — an empty list is a lock-out, not an absence |

An absent field means "no filtering on this axis". An empty array means "nothing
allowed", which is why `allowTools: []` disables a server's tools without
removing its config. `denyTools: []` denies nothing, as you would expect.

### Names are the UPSTREAM names

Entries match the tool name as the server reports it, **not** the aggregated
name your client sees. With `id: "bank"` and `autoPrefix`, the served name is
`bank_get_balance`; you write `get_balance`. This is deliberate: the filter is
about the capability, so a later change to `prefix` or `autoPrefix` cannot
silently widen or narrow what you granted.

If a configured name matches no upstream tool, startup logs a warning naming
every unmatched entry. The check runs against the server's advertised list, so
a typo or a renamed tool surfaces instead of quietly filtering nothing.

### What a denied tool looks like

It is not advertised and it cannot be called. Denied tools never enter the
routing map, so `executeTool` rejects them as unknown — there is no path that
reaches the upstream server by name. Filtering happens before prefix
composition, so a dropped tool also does not consume a collision slot and
rename a tool that is actually served.

This is a visibility control on the aggregator, not a substitute for scopes.
Prefer removing the capability at the credential boundary when the server
offers one; use this when it does not, or as a second layer.

Available since `1.9.0`.

## Runtime Resilience

The aggregator is designed to survive individual MCP server failures without
crashing the entire process:

- **Connection failures**: If one MCP server fails to connect at boot, the
  aggregator logs the error and continues with the remaining servers. The
  failed server's tools are simply unavailable — all other servers operate
  normally.

- **Tool listing failures**: If `listTools()` fails for one MCP during
  `getTools()`, that MCP contributes zero tools. Other MCPs' tools are still
  collected and returned.

- **Tool execution failures**: If `callTool()` fails during execution, a
  structured MCP error response is returned (`{ isError: true, content: [...] }`)
  with a descriptive message. The aggregator process remains healthy.

This means a single broken MCP server can no longer take down your entire
aggregation gateway.

Available since `1.6.6`.

## Socket Binding: host and port

HTTP and SSE servers bind on `port` and, optionally, `host`. Both are set on
the server connection object - never at the top level.

```json
{
  "aggregator": {
    "server": {
      "connection": {
        "type": "http",
        "url": "http://127.0.0.1:12001",
        "port": 12001,
        "host": "127.0.0.1"
      }
    }
  }
}
```

- `port` defaults to **3000**.
- `host` is **omitted by default**, which means Node binds **all interfaces**
  (`0.0.0.0` and `::`) - so a default install is reachable from the network,
  not just loopback.
- Set `host` to `"127.0.0.1"` to bind loopback only. This matters behind a
  reverse proxy, on a shared host, or any time the port should not be exposed
  directly. It is the difference between "listening" and "exposed".

`url` is documentation for clients - it does not affect the bind. If you set
`host`, keep `url` consistent with it or a reader will infer the wrong
reachability.

```bash
# verify what actually got bound
ss -tlnp | grep 12001
```

Applies to the aggregator `http` and `sse` entries and to all three simple
server entries (`http`, `stateless-http`, `sse`).

Available since `1.6.7`.

## Running Aggregator (server from CLI)

Installing this library globally adds an `mcp-aggregator` command for starting
aggregators in any context.

```bash
npm i -g @retiform/mcp-ai
```

Once installed:

```bash
mcp-aggregator ./path-to-your-config.json
```

No extra flags are needed: argument parsing uses Node built-in
`node:util.parseArgs`, so there is no `argparse` dependency and nothing else
to install. `--help` (`-h`) and `--version` (`-v`) are supported.

This is very useful for running this as a server process, in something like a docker container.

## Server Authentication

Aggregator HTTP and SSE servers can require an API key on every request.

### Declaring auth

Add an `auth` object to the server connection in your config:

```json
{
  "aggregator": {
    "server": {
      "connection": {
        "type": "http",
        "url": "http://127.0.0.1:12001",
        "port": 12001,
        "auth": {
          "type": "bearer",
          "env": "MCP_API_KEY"
        }
      }
    }
  }
}
```

- `type` must be `"bearer"`.
- `env` names the environment variable holding the API key. Default:
  `MCP_API_KEY`.

### Supplying the key

The key itself is **never a config value** — configs leak into backups,
logs, and version control. Set the named environment variable before
starting the server:

```bash
export MCP_API_KEY="$(openssl rand -hex 32)"
mcp-aggregator ./config.json
```

### Behavior

- Requests must present the key as `Authorization: Bearer <key>` or
  `x-api-key: <key>` (checked in that order).
- Comparison is constant-time (sha256 + `crypto.timingSafeEqual`).
- Missing or wrong key: `401` with a `WWW-Authenticate: Bearer` header
  (RFC 6750). No key material is ever echoed.
- `OPTIONS` preflight requests pass through without credentials, so
  browser CORS clients keep working.
- **Fail-closed:** if `auth` is declared but the environment variable is
  unset or empty, the server **refuses to start**. A server configured
  for auth never boots unauthenticated.

### Client side

Any MCP client that can set custom headers works out of the box — add a
header `Authorization: Bearer <your-key>` to the client's server entry.

Available since `1.7.0`.

## OAuth for HTTP Children

An `http` child can present OAuth 2.1 credentials. Discovery, dynamic client
registration, PKCE (S256), code exchange, and refresh-on-401 are handled by the
MCP SDK; this library supplies the persistent state it delegates to, and adds
one guarantee the protocol itself does not give you.

**`auth` and `oauth` are different things.** `auth` on a _server_ connection is
the credential **we demand** from inbound callers. `oauth` on an _http client_
connection is the credential **we obtain** from somebody else's resource
server. They are deliberately not the same key.

### Declaring it

```json
{
  "aggregator": {
    "mcps": [
      {
        "id": "example",
        "connection": {
          "type": "http",
          "url": "https://mcp.example.com",
          "oauth": {
            "tokenFile": "/home/me/.config/mcp-oauth/example.json",
            "redirectUrl": "http://127.0.0.1:8899/cb",
            "scopes": ["user:read", "records:read"],
            "allowedScopes": ["user:read", "records:read"],
            "clientName": "my-aggregator",
            "userAgent": "my-aggregator/1.0"
          }
        }
      }
    ]
  }
}
```

| Field           | Meaning                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokenFile`     | Where tokens, client registration, the PKCE verifier and discovery state are kept. Written atomically at mode `600`.                              |
| `redirectUrl`   | Loopback redirect URI. Must be `http://127.0.0.1:<port>/<path>` or `http://localhost:<port>/<path>`, with an explicit port.                       |
| `scopes`        | What we **ask for** — sent as the authorization request's `scope` and as the client metadata `scope`.                                             |
| `allowedScopes` | The most we will ever **store**. See the guarantee below.                                                                                         |
| `clientName`    | Sent with dynamic client registration.                                                                                                            |
| `userAgent`     | User-Agent for the OAuth HTTP calls. Set this if the provider's endpoints sit behind a WAF that rejects default library agents with a bare `403`. |

### The one-shot login

Authorization is **not** part of server startup. A server never waits for a
human: it reads the tokens it finds and starts without any child it cannot
authenticate, so one unavailable resource server cannot hold up the rest.

Run the flow once, separately:

```bash
mcp-aggregator login ./config.json example
```

It prints an authorization URL, waits on the configured loopback port, and
writes the token file. Then start (or restart) the aggregator normally.

The redirect is loopback, which the authorization server requires and which
means **the browser must run on the same machine as the `login` process**.
Loopback is machine-wide rather than per-user, so any local account's browser
works. If the port is already bound, an earlier login is probably still
running; if the window is closed before the confirmation page loads, the code
never arrives and the command times out rather than reporting a false success.

### Scope enforcement at the credential boundary

This is the part worth knowing about, because the protocol does not give it to
you.

The SDK resolves the requested scope as:

```
explicit scope  ??  the resource server's advertised scope list  ??  our client metadata scope
```

A resource server that advertises a broader set than you want therefore
**outranks your own client metadata**, and it can cause a scope you did not
intend to be _asked for_. You cannot reliably prevent that from the client
side.

What you _can_ control is what gets **kept**. Every token is validated against
`allowedScopes` before it is written. If the grant includes a scope outside
that list, `saveTokens()` throws, names the offending scope, and **persists
nothing** — so a token carrying an over-broad grant can never reach a later
request. This also holds for a refresh response that omits `scope` (meaning
"unchanged"): the previously accepted grant is re-validated rather than waved
through.

Use `scopes` to ask for what you need and `allowedScopes` to state the ceiling.
They are usually identical. They are separate so that the ceiling cannot be
widened by the far side.

### Token file handling

- Written atomically: temp file plus `rename`, so a concurrent reader sees the
  previous complete file or the new one, never a truncated one. A crash
  therefore cannot cost you a refresh token.
- Created at mode `600`, set at `open()` rather than after the write, so the
  file is never briefly readable by others.
- **Read is fail-closed.** A token file whose group or other bits are set is
  refused with an instruction to `chmod 600`, not used with a warning. `400` is
  accepted, since owner-read-only is a legitimate tightening.
- Corrupt JSON is refused rather than treated as "no tokens" — re-authorizing
  over a file you may need to inspect is worse than stopping.

### State and CSRF

The provider generates and persists an OAuth `state` value per authorization
attempt, and `login` compares it against the value that comes back. The SDK
mints and sends a state when a provider supplies one, but does not compare it
on return, so without this check a forged callback would be
indistinguishable from a genuine one.

### Headers

`connection.headers` is honored on `http` connections. Set static headers
there; use `oauth` for anything that has to be refreshed.

Available since `1.8.0`.

## Overview

This library is made up of two different domains.

### Integration

This library has convenient and simple tooling for integrating MCP servers into LLM workflows with tools that do the formatting for you to and from the `@modelcontextprotocol/sdk` library.

#### LLM Provider Support

Currently supports the following LLM Client's Format:

- Openai
- Anthropic
- AWS Bedrock Claude

#### A Note For Frontend Use

Make sure you use an appropriate tree shaker to remove any aggregation code, because the aggregation code is Node-only: it pulls in the stdio and socket transports, which in turn require child_process and the node builtins. A browser bundler cannot resolve those.

The same is true even of a bundle that only needs the formatting helpers. The transport modules are imported statically rather than lazily, so a tree shaker cannot drop them on its own. Alias the node builtins to a browser shim, or keep this library out of the client bundle entirely.

### Aggregation

The aggregation tooling is used for taking many different MCP servers and putting them under one configuration roof. You can attach many different MCPs to a single system with just a configuration file.

This can be useful in scenarios where you want to package all of your MCPs into 1+ docker images, set them up with a single docker-compose.yml file, and then travel around with that docker compose file, empowering AI systems everywhere.

You can even save your configuration file with your system, making it clear what MCP's are required for your system to work. (Pretty cool huh?)

#### MCP Connections Supported

- CLI STDOUT IO
- HTTP
- SSE

### Using Them Together

`LLM Providers -> Integrator -> Aggregator -> MCP Servers`

## Configuration Examples

### Integrator Configurations

#### CLI Integrator

```json
{
  "integrator": {
    "connection": {
      "type": "cli",
      "path": "tsx",
      "args": ["./bin/cliServer.mts", "./config.json"]
    },
    "provider": "aws-bedrock-claude",
    "model": "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "modelId": "arn:aws:bedrock:us-east-1:461659650211:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "maxParallelCalls": 1
  }
}
```

#### HTTP Integrator

```json
{
  "integrator": {
    "connection": {
      "type": "http",
      "url": "http://localhost:3000",
      "headers": {
        "Content-Type": "application/json"
      }
    },
    "provider": "openai",
    "model": "gpt-4-turbo-preview",
    "maxParallelCalls": 1
  }
}
```

#### SSE Integrator

```json
{
  "integrator": {
    "connection": {
      "type": "sse",
      "url": "http://localhost:3000"
    },
    "provider": "claude",
    "model": "claude-3-opus-20240229",
    "maxParallelCalls": 1
  }
}
```

### Server Configurations

#### CLI Server

```json
{
  "aggregator": {
    "server": {
      "connection": {
        "type": "cli"
      },
      "maxParallelCalls": 10
    },
    "mcps": [
      {
        "id": "filesystem",
        "connection": {
          "type": "cli",
          "path": "npx",
          "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
      }
    ]
  }
}
```

#### HTTP Server

```json
{
  "aggregator": {
    "server": {
      "connection": {
        "type": "http",
        "url": "http://localhost:3000",
        "port": 3000
      },
      "path": "/",
      "maxParallelCalls": 10
    },
    "mcps": [
      {
        "id": "filesystem",
        "connection": {
          "type": "cli",
          "path": "npx",
          "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
      }
    ]
  }
}
```

#### SSE Server

```json
{
  "aggregator": {
    "server": {
      "connection": {
        "type": "sse",
        "url": "http://localhost:3000",
        "port": 3000
      },
      "path": "/",
      "messagesPath": "/messages",
      "maxParallelCalls": 10
    },
    "mcps": [
      {
        "id": "filesystem",
        "connection": {
          "type": "cli",
          "path": "npx",
          "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
      }
    ]
  }
}
```

### MCP Connection Variations

#### CLI MCP Connection

```json
{
  "id": "memory",
  "connection": {
    "type": "cli",
    "path": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "env": {
      "MEMORY_PATH": "./data"
    },
    "cwd": "./"
  }
}
```

#### HTTP MCP Connection

```json
{
  "id": "filesystem",
  "connection": {
    "type": "http",
    "url": "http://localhost:3001",
    "headers": {
      "Authorization": "Bearer your-token"
    },
    "timeout": 5000,
    "retry": {
      "attempts": 3,
      "backoff": 1000
    }
  }
}
```

#### SSE MCP Connection

```json
{
  "id": "streaming",
  "connection": {
    "type": "sse",
    "url": "http://localhost:3002"
  }
}
```

#### WebSocket MCP Connection

```json
{
  "id": "realtime",
  "connection": {
    "type": "ws",
    "url": "ws://localhost:3003",
    "protocols": ["mcp-v1"],
    "headers": {
      "Authorization": "Bearer your-token"
    },
    "reconnect": {
      "attempts": 5,
      "backoff": 1000
    }
  }
}
```

### Full Configuration Example

A complete configuration combining both integrator and aggregator:

```json
{
  "integrator": {
    "connection": {
      "type": "cli",
      "path": "tsx",
      "args": ["./bin/cliServer.mts", "./config.json"]
    },
    "provider": "aws-bedrock-claude",
    "model": "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "modelId": "arn:aws:bedrock:us-east-1:461659650211:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    "maxParallelCalls": 1
  },
  "aggregator": {
    "server": {
      "connection": {
        "type": "cli"
      },
      "maxParallelCalls": 10
    },
    "mcps": [
      {
        "id": "filesystem",
        "connection": {
          "type": "cli",
          "path": "npx",
          "args": ["-y", "@modelcontextprotocol/server-memory"]
        }
      }
    ]
  }
}
```

## Testing

```bash
npm test                # mocha + tsx, 140 tests
npm run test:coverage   # same suite under c8 (cobertura, lcov, html)
```

The suite runs entirely offline - no provider keys and no network calls. Every
entry path binds an ephemeral port, so a run needs no reserved ports and does
not collide with a running service. Coverage, by concern:

- **Tool namespace prefixing** - prefix resolution, name composition, and
  collision resolution when two MCPs expose the same tool name.
- **Runtime resilience** - the `disabled` flag, plus connect, `getTools` and
  `executeTool` behaviour when one MCP fails while others stay healthy.
- **Bearer authentication** - header extraction, secret resolution (including
  fail-closed when the env var is unset), the middleware invoked directly, and
  a real express app exercised end-to-end over a socket with `fetch`.
- **Socket binding** - `connection.host` and `connection.port` on the
  aggregator HTTP/SSE entries and the simple server, each with a
  backward-compatibility case for the omitted field, plus an e2e assertion
  that a non-bound interface refuses the connection.
- **Schema conversion** - `openApiToZodSchema`, including enum enforcement and
  rejection of malformed property tokens.

### Environment Variables

No environment variables are required. If you add tests that call a real provider, export the matching key:

- OpenAI: `OPENAI_API_KEY`
- Claude: `ANTHROPIC_API_KEY`
- AWS Bedrock: AWS credentials configured in your environment

## Notes

- The `modelId` field is required for AWS Bedrock and should be the ARN of your model
- For HTTP and SSE servers, the `port` field is optional and defaults to 3000
- The `path` field in server configurations is optional and defaults to '/'
- For SSE servers, the `messagesPath` field is optional and defaults to '/messages'
- `maxParallelCalls` is optional and defaults to 10 for both integrators and servers
- `toolTimeoutMs` is optional and defaults to `180000` ms (three minutes) for
  aggregator tool calls. Raise it for slow backends; lower it to fail fast

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## License

GPL-3.0-or-later

Built on [`@l4t/mcp-ai`](https://github.com/Leadership-4-Tech/mcp-ai) by
[Mike Cornwell](https://github.com/Leadership-4-Tech/mcp-ai), whose design this
library still follows. Maintained by [Guan](https://github.com/retiform-labs) at
[Retiform Labs](https://retiform.dev), published as
[`@retiform/mcp-ai`](https://www.npmjs.com/package/@retiform/mcp-ai).

See the [CHANGELOG](./CHANGELOG.md) for what differs from upstream, and the git
log for the detail behind it.
