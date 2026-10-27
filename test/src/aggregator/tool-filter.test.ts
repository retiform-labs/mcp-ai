/**
 * Per-tool allow/deny filtering at the roster assembly point.
 *
 * This is a security control, so it is proven by control mutation rather than
 * by a green happy path. Remove the `filterTools(...)` call in
 * `aggregator/services.ts` `getTools` (replace it with the raw list) and the
 * following MUST fail:
 *   - 'denies a named tool from the roster'
 *   - 'denies a named tool from routing (executeTool rejects it)'
 *   - 'allow list narrows the roster to the named tools'
 *   - 'deny wins when both lists name the same tool'
 *   - 'an empty allow list denies everything from that server'
 * If those stay green with the filter removed, the filter is decorative.
 *
 * Backward compatibility is asserted separately: an entry with neither field
 * must produce byte-identical behavior to the pre-filter aggregator.
 */
import { describe, it, beforeEach, afterEach } from 'mocha'
import { expect } from 'chai'
import sinon from 'sinon'
import { isToolAllowed, filterTools } from '../../../src/aggregator/tool-filter'
import { create } from '../../../src/aggregator/services'
import { McpAggregatorConfig } from '../../../src/common/types'

const CLI_CONNECTION = { type: 'cli' as const, path: 'echo' }

const createMockClient = (
  tools: Array<{ name: string; description?: string; inputSchema?: any }>
) =>
  ({
    listTools: sinon.stub().resolves({ tools, nextCursor: undefined }),
    callTool: sinon.stub().resolves({
      content: [{ type: 'text', text: 'ok' }],
    }),
    connect: sinon.stub().resolves(),
    close: sinon.stub().resolves(),
  }) as any

const createMockClientFactory = (clients: Array<any>) => {
  let callCount = 0
  return async () => clients[callCount++] ?? createMockClient([])
}

const createConfig = (
  mcps: Array<{
    id: string
    connection: any
    prefix?: string
    disabled?: boolean
    allowTools?: readonly string[]
    denyTools?: readonly string[]
  }>,
  extra?: Partial<McpAggregatorConfig>
): McpAggregatorConfig =>
  ({
    mcps,
    autoPrefix: true,
    prefix: '',
    ...extra,
  }) as McpAggregatorConfig

describe('tool-filter — isToolAllowed', () => {
  it('allows everything when neither list is set', () => {
    expect(isToolAllowed('anything', undefined, undefined)).to.be.true
  })

  it('denies a named tool when deny is set', () => {
    expect(isToolAllowed('danger', undefined, ['danger'])).to.be.false
  })

  it('allows an unlisted tool when only deny is set', () => {
    expect(isToolAllowed('safe', undefined, ['danger'])).to.be.true
  })

  it('allows only the named tools when allow is set', () => {
    expect(isToolAllowed('listed', ['listed'], undefined)).to.be.true
    expect(isToolAllowed('unlisted', ['listed'], undefined)).to.be.false
  })

  it('deny wins when both lists name the same tool', () => {
    expect(isToolAllowed('both', ['both'], ['both'])).to.be.false
  })

  it('an EMPTY allow list denies everything (deliberate, not unset)', () => {
    expect(isToolAllowed('anything', [], undefined)).to.be.false
  })

  it('an empty deny list denies nothing', () => {
    expect(isToolAllowed('anything', undefined, [])).to.be.true
  })
})

describe('tool-filter — filterTools', () => {
  const tools = [{ name: 'a' }, { name: 'b' }]

  it('returns the same list when no filter is configured', () => {
    const unmatched = new Set<string>()
    expect(filterTools('m', tools, { id: 'm' }, unmatched)).to.equal(tools)
    expect(unmatched.size).to.equal(0)
  })

  it('records configured names that match no upstream tool', () => {
    const unmatched = new Set<string>()
    filterTools('m', tools, { id: 'm', denyTools: ['ghost'] }, unmatched)
    expect([...unmatched]).to.deep.equal(['m:ghost'])
  })
})

describe('tool-filter — aggregated roster integration', () => {
  let sandbox: sinon.SinonSandbox
  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(console, 'warn')
  })
  afterEach(() => sandbox.restore())

  it('serves every tool when neither field is set (backward compatible)', async () => {
    const client = createMockClient([{ name: 'one' }, { name: 'two' }])
    const services = create(
      createConfig([{ id: 'm', connection: CLI_CONNECTION }]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    const names = (await services.getTools()).map(t => t.name)
    expect(names).to.have.length(2)
  })

  it('denies a named tool from the roster', async () => {
    const client = createMockClient([{ name: 'keep' }, { name: 'nuke' }])
    const services = create(
      createConfig([
        { id: 'm', connection: CLI_CONNECTION, denyTools: ['nuke'] },
      ]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    const names = (await services.getTools()).map(t => t.name)
    expect(names).to.have.length(1)
    expect(names[0]).to.include('keep')
  })

  it('denies a named tool from ROUTING by its composed name', async () => {
    // The composed name matters: with autoPrefix and id 'm', the served name of
    // 'nuke' is 'm_nuke'. Asserting executeTool('nuke') would pass for the WRONG
    // reason (that name is never routable, filter or no filter) and would stay
    // green under the mutation. Control: the same composed name MUST route when
    // the tool is not denied.
    const deniedClient = createMockClient([{ name: 'keep' }, { name: 'nuke' }])
    const denied = create(
      createConfig([
        { id: 'm', connection: CLI_CONNECTION, denyTools: ['nuke'] },
      ]),
      { createClientFn: createMockClientFactory([deniedClient]) }
    )
    await denied.connect()
    const served = (await denied.getTools()).map(t => t.name)
    expect(served).to.deep.equal(['m_keep'])

    let caught: Error | undefined
    try {
      await denied.executeTool('m_nuke', {})
    } catch (e) {
      caught = e as Error
    }
    expect(caught, 'denied tool must not be routable').to.exist
    expect(caught!.message).to.match(/Unknown tool/)
    expect(deniedClient.callTool.called).to.be.false

    // Control: allow the same tool and the composed name DOES route.
    const allowedClient = createMockClient([{ name: 'nuke' }])
    const allowed = create(
      createConfig([{ id: 'm', connection: CLI_CONNECTION }]),
      { createClientFn: createMockClientFactory([allowedClient]) }
    )
    await allowed.connect()
    expect((await allowed.getTools()).map(t => t.name)).to.deep.equal(['m_nuke'])
    await allowed.executeTool('m_nuke', {})
    expect(allowedClient.callTool.calledOnce, 'control must actually route').to.be
      .true
  })

  it('allow list narrows the roster to the named tools', async () => {
    const client = createMockClient([
      { name: 'read_one' },
      { name: 'read_two' },
      { name: 'write_all' },
    ])
    const services = create(
      createConfig([
        {
          id: 'm',
          connection: CLI_CONNECTION,
          allowTools: ['read_one', 'read_two'],
        },
      ]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    const names = (await services.getTools()).map(t => t.name)
    expect(names).to.have.length(2)
    expect(names.join(',')).to.not.include('write_all')
  })

  it('deny wins when both lists name the same tool', async () => {
    const client = createMockClient([{ name: 'x' }, { name: 'y' }])
    const services = create(
      createConfig([
        {
          id: 'm',
          connection: CLI_CONNECTION,
          allowTools: ['x', 'y'],
          denyTools: ['y'],
        },
      ]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    const names = (await services.getTools()).map(t => t.name)
    expect(names).to.have.length(1)
    expect(names[0]).to.include('x')
  })

  it('an empty allow list denies everything from that server', async () => {
    const client = createMockClient([{ name: 'any' }])
    const services = create(
      createConfig([
        { id: 'm', connection: CLI_CONNECTION, allowTools: [] },
      ]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    expect(await services.getTools()).to.have.length(0)
  })

  it('warns when a configured entry matches no upstream tool', async () => {
    const client = createMockClient([{ name: 'real' }])
    const services = create(
      createConfig([
        { id: 'm', connection: CLI_CONNECTION, denyTools: ['typo_name'] },
      ]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    await services.getTools()
    const warn = (console.warn as sinon.SinonStub)
    const hit = warn.getCalls().find(c => /matched no upstream tool/.test(String(c.args[0])))
    expect(hit, 'unmatched filter entries must be warned about').to.exist
    expect(String(hit!.args[0])).to.include('m:typo_name')
  })

  it('filters on the UPSTREAM name, not the prefixed name', async () => {
    const client = createMockClient([{ name: 'secret_tool' }])
    const services = create(
      createConfig([
        { id: 'svc', connection: CLI_CONNECTION, denyTools: ['secret_tool'] },
      ]),
      { createClientFn: createMockClientFactory([client]) }
    )
    await services.connect()
    expect(await services.getTools()).to.have.length(0)
  })
})
