// Real installed DSH loader, credential provider and Typert gateway; synthetic account only.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.ok(process.env.DSH_TEST_NODE_MODULES, 'set DSH_TEST_NODE_MODULES to the actual host dependencies')
const req = createRequire(join(resolve(process.env.DSH_TEST_NODE_MODULES), '__ollama_host.cjs'))
// Reuse the same synthetic host fixture against the exact packed/installed artifact.
const repo = process.env.DSH_TEST_PACKAGE_DIR ? resolve(process.env.DSH_TEST_PACKAGE_DIR) : fileURLToPath(new URL('../', import.meta.url)), cwd = process.cwd()
const work = mkdtempSync(join(tmpdir(), 'cm-ollama-runtime-'))
const names = ['DSH_HOME', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OLLAMA_API_KEY']
const saved = Object.fromEntries(names.map(name => [name, process.env[name]])), realFetch = globalThis.fetch
const token = 'OLLAMA_SYNTHETIC_KEY_A', secondToken = 'OLLAMA_SYNTHETIC_KEY_B', errors = [], calls = []
let host, peer
try {
  for (const name of names) delete process.env[name]
  Object.assign(process.env, { DSH_HOME: work, HOME: work, USERPROFILE: work, XDG_CONFIG_HOME: join(work, 'config') })
  process.chdir(work)
  const imp = name => import(pathToFileURL(req.resolve(name)).href)
  const { Context } = await imp('@deepseek-ai/cordis')
  const { default: Loader } = await imp('@deepseek-ai/cordis-plugin-loader')
  const { default: Registry } = await imp('@deepseek-ai/dsh-typert-registry')
  const TypertLoader = await imp('@deepseek-ai/dsh-typert-loader')
  const { default: Gateway } = await imp('@deepseek-ai/dsh-api-gateway')
  const { default: Credentials } = await imp('@deepseek-ai/dsh-credentials-local')
  const RemoteAccess = Gateway.inject?.includes('remoteAccess') ? (await imp('@deepseek-ai/dsh-api-remote-access')).default : null
  const storage = join(work, 'storages', 'cost-meter'); mkdirSync(storage, { recursive: true })
  const ledger = join(storage, 'ledger.json')
  writeFileSync(ledger, JSON.stringify({ version: 1, days: {}, config: { locale: 'en', balance: { display: 'off' }, goQuota: { enabled: false } } }))
  writeFileSync(join(work, 'package.json'), '{"type":"module"}')
  const anchor = pathToFileURL(join(work, 'package.json')).href
  host = new Context(); host.baseUrl = anchor
  host.logger = { error: error => errors.push(String(error)), warn() {}, info() {} }
  if (process.env.DSH_TEST_PROFILE_DIR) {
    // Packed profiles deliberately omit host peers. Match the real launcher rather
    // than adding duplicate DSH packages to the tested installation.
    const { PluginPackages, createRuntimeResolution, loadProfileDirectory } = await imp('@deepseek-ai/dsh-app-boot')
    const profileDir = resolve(process.env.DSH_TEST_PROFILE_DIR)
    const installAnchor = req.resolve('@deepseek-ai/dsh/package.json')
    const profile = loadProfileDirectory('ollama-runtime-test', profileDir, installAnchor, { userLayer: false })
    assert.deepEqual(profile.skippedBundles, [])
    const resolution = await createRuntimeResolution({ installAnchor, profile, home: dirname(dirname(profileDir)) })
    await host.plugin(PluginPackages, { resolution }).await()
  }
  const lifetime = new AbortController()
  peer = { id: 'cm-ollama-owner', ctx: host, principal: { kind: 'owner' }, signal: lifetime.signal, interactions: 'none', dispose: async () => lifetime.abort() }
  const invoke = (method, args = {}) => host.typertGateway.invoke({ namespace: 'costMeter', method, args, ...(RemoteAccess ? { peer } : {}) })
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://ollama.com'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual')
    const isSecond = init.headers.authorization === 'Bearer ' + secondToken
    assert.ok(isSecond || init.headers.authorization === 'Bearer ' + token)
    calls.push(init.headers.authorization)
    if (parsed.pathname === '/api/balance') return Response.json({ included: { balance_usd: isSecond ? 12 : 40, allowance_usd: 60,
      period: { from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' } }, purchased: { balance_usd: 0 } })
    return Response.json({ range: parsed.searchParams.get('range'), from: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z',
      totals: { request_count: 2, usage_usd: 0.015, input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } })
  }
  await host.plugin(Loader, { baseUrl: anchor }).await()
  await host.plugin(Registry).await(); await host.plugin(TypertLoader, { packages: [] }).await()
  await host.plugin(Credentials, { path: join(work, '.credentials.yaml'), watch: false }).await()
  if (RemoteAccess) await host.plugin(RemoteAccess).await()
  await host.plugin(Gateway, {}).await()
  await host.loader.root.update([{ id: 'cost-meter', name: pathToFileURL(join(repo, 'lib/index.js')).href }]); await host.loader.await()
  assert.ok(host.typert.getPackage('dsh-cost-meter'), 'costMeter failed to register: ' + errors.join('\n'))
  const initial = await invoke('getState')
  assert.equal(initial.codingPlans['ollama-cloud'].enabled, false); assert.equal(calls.length, 0)
  assert.equal((await invoke('setCredential', { target: 'codingPlans.ollama-cloud', value: token })).ok, true)
  await invoke('updateConfig', { patch: { codingPlans: { 'ollama-cloud': { enabled: true, display: 'both' } } } })
  const first = await invoke('refreshCodingPlan', { provider: 'ollama-cloud' })
  assert.equal(first.ok, true, first.message)
  assert.equal(first.state.codingPlans['ollama-cloud'].ollama.included.balanceUsd, 40)
  assert.equal(first.state.codingPlans['ollama-cloud'].ollama.usage['24h'].usageUsd, 0.015)
  assert.equal(calls.length, 4)
  // Exercise the real public reference-updated event, not costMeter's explicit reset.
  await host.credentials.set('OLLAMA_API_KEY', secondToken)
  const second = await invoke('refreshCodingPlan', { provider: 'ollama-cloud' })
  assert.equal(second.ok, true, second.message)
  assert.equal(second.state.codingPlans['ollama-cloud'].ollama.included.balanceUsd, 12)
  assert.equal(calls.length, 8, 'external key rotation bypasses the prior account cache')
  await host.credentials.unset('OLLAMA_API_KEY')
  const cleared = await invoke('refreshCodingPlan', { provider: 'ollama-cloud' })
  assert.equal(cleared.ok, false)
  assert.equal(cleared.state.codingPlans['ollama-cloud'].ollama, undefined)
  assert.equal(calls.length, 8, 'no credential means no network request')
  assert.equal(second.state.today.calls, initial.today.calls, 'account data never adds session calls')
  assert.ok(!JSON.stringify(second).includes('OLLAMA_SYNTHETIC'))
  assert.ok(!readFileSync(ledger, 'utf8').includes('OLLAMA_SYNTHETIC'))
  assert.deepEqual(errors, [])
  console.log('[ok] actual DSH ' + req('@deepseek-ai/dsh/package.json').version + ': Ollama RPC, real credential rotation, balance/usage codec and ledger isolation; no external requests')
} finally {
  await peer?.dispose(); await host?.fiber.dispose()
  globalThis.fetch = realFetch; process.chdir(cwd)
  for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]
  assert.equal(dirname(work), tmpdir())
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
