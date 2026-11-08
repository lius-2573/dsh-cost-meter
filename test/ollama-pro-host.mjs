import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'
import { sanitizeConfig, applyConfigPatch, secretRefOf, stripSecrets } from '../lib/store.js'
import { stateSchema } from '../lib/typert.host.js'
import { CLIENT_CONTRIBUTION } from './typert-codecs.mjs'
import { billingClassOf, enabledPlanSetOf, recordSamples, buildPlanStats } from '../lib/plan-billing.js'

const id = 'ollama-cloud'
const config = sanitizeConfig({ codingPlans: { [id]: { enabled: true, display: 'both', apiKey: 'PRIVATE_TEST_KEY' } } })
assert.equal(secretRefOf('codingPlans.' + id), 'OLLAMA_API_KEY')
assert.equal(stripSecrets(config).codingPlans[id].apiKey, '')
assert.equal(applyConfigPatch(config, { codingPlans: { [id]: { refreshMinutes: 5 } } }).errors.length, 0)
assert.equal(billingClassOf('ollama', 'qwen3', config.planBilling, enabledPlanSetOf(config)), 'api', 'local Ollama is unchanged')
assert.equal(billingClassOf(id, 'deepseek-v4-pro', config.planBilling, enabledPlanSetOf(config)), 'api', 'balance display does not reclassify billed calls')
assert.deepEqual(recordSamples({}, id, { monthly: { percent: 40, resetsAt: '' } }, {}, Date.now()), {})
assert.equal(buildPlanStats({ days: {}, hourBuckets: {}, samples: {}, codingPlans: { [id]: { status: 'ok', windows: { monthly: { percent: 40, resetsAt: '' } } } }, config }).providers[id], undefined)

const period = { from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' }
const balance = { included: { balance_usd: 40, allowance_usd: 60, period }, purchased: { balance_usd: 0 } }
const rotatedBalance = { included: { balance_usd: 10, allowance_usd: 100, period }, purchased: { balance_usd: 0 } }
const lateBalance = { included: { balance_usd: 999, allowance_usd: 1000, period }, purchased: { balance_usd: 0 } }
const usage = range => ({ range, scope: 'self', from: '2026-11-01T00:00:00Z', until: '2026-11-08T00:00:00Z', totals: { request_count: 0, usage_usd: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, buckets: [] })
const root = mkdtempSync(join(tmpdir(), 'cm-ollama-host-'))
const names = ['DSH_HOME', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'OLLAMA_API_KEY']
const saved = Object.fromEntries(names.map(name => [name, process.env[name]]))
const originalFetch = globalThis.fetch, originalNow = Date.now
const disposers = []
const listeners = new Map()
const emit = (event, payload) => { for (const handler of listeners.get(event) ?? []) handler(payload) }
// 等待异步链路推进到条件成立,不用固定 tick 数猜时序。
const until = async predicate => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('等待条件超时')
}
let clock = originalNow(), calls = [], mode = 'ok', expectedKey = 'PRIVATE_TEST_KEY'
let gate = null, gateSignal = null, gateBalance = balance
try {
  for (const name of names) delete process.env[name]
  process.env.DSH_HOME = process.env.USERPROFILE = process.env.HOME = root
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  Date.now = () => clock
  const storage = join(root, 'storages', 'cost-meter')
  mkdirSync(storage, { recursive: true })
  writeFileSync(join(storage, 'ledger.json'), JSON.stringify({ version: 1, config: { balance: { display: 'off' }, goQuota: { enabled: false } }, days: {} }))
  const secrets = new Map(), services = {}
  const credentials = {
    resolve: async ref => secrets.has(String(ref)) ? { value: secrets.get(String(ref)), source: 'file' } : undefined,
    describe: async ref => ({ configured: secrets.has(String(ref)), source: 'file' }),
    set: async (ref, value) => secrets.set(String(ref), value), unset: async ref => secrets.delete(String(ref)),
  }
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://ollama.com')
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.authorization, 'Bearer ' + expectedKey)
    calls.push(String(url))
    if (mode === 'gated') {
      gateSignal = init.signal
      return new Promise((resolve, reject) => {
        gate = { release: () => resolve(new Response(JSON.stringify(parsed.pathname === '/api/balance' ? gateBalance : usage(parsed.searchParams.get('range'))))) }
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    if (mode === 'unauthorized') return new Response('PRIVATE_SERVER_BODY', { status: 401 })
    if (mode === 'failure') return new Response('PRIVATE_SERVER_BODY', { status: 503 })
    if (mode === 'limited') return new Response('PRIVATE_SERVER_BODY', { status: 429, headers: { 'retry-after': '180' } })
    if (mode === 'partial' && parsed.searchParams.get('range') === '7d') return new Response('PRIVATE_SERVER_BODY', { status: 500 })
    if (mode === 'usagefail' && parsed.pathname === '/api/usage') return new Response('PRIVATE_SERVER_BODY', { status: 401 })
    const body = parsed.pathname === '/api/balance' ? (mode === 'rotated' ? rotatedBalance : balance) : usage(parsed.searchParams.get('range'))
    return new Response(JSON.stringify(body))
  }
  apply({ get: name => name === 'credentials' ? credentials : undefined,
    provide: (name, service) => { services[name] = service },
    on: (event, handler) => { const list = listeners.get(event) ?? []; list.push(handler); listeners.set(event, list); return () => {} },
    inject() {},
    effect: fn => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer) },
    logger: { info() {}, warn() {}, error() {} },
  })
  const meter = services.costMeter
  assert.ok((listeners.get('credentials/reference-updated') ?? []).length > 0, '监听设置页的外部凭据轮换事件')
  const initial = await meter.getState()
  assert.equal(initial.codingPlans[id].enabled, false)
  assert.equal(calls.length, 0, 'disabled by default')
  assert.equal((await meter.setCredential('codingPlans.' + id, 'PRIVATE_TEST_KEY')).ok, true)
  await meter.updateConfig({ codingPlans: { [id]: { enabled: true, display: 'both', refreshMinutes: 5 } } })
  const first = await meter.refreshCodingPlan(id)
  assert.equal(first.ok, true, first.message)
  const live = first.state.codingPlans[id]
  assert.equal(live.ollama.included.allowanceUsd, 60)
  assert.equal(live.ollama.purchasedBalanceUsd, 0)
  assert.equal(live.ollama.usage['24h'].usageUsd, 0)
  assert.equal(live.windows.monthly.percent, 33.33, 'percent is used (40/60), not remaining')
  assert.equal(live.keyConfigured, true)
  assert.equal(calls.length, 4)
  assert.equal(first.state.planStats.providers[id], undefined, 'no invented per-percent local estimates')
  const clientCodec = CLIENT_CONTRIBUTION.descriptors.find(d => d.method === 'getState').result.create()
  for (const state of [stateSchema.parse(first.state), clientCodec.parse(JSON.parse(JSON.stringify(first.state)))]) {
    assert.equal(state.codingPlans[id].ollama.included.balanceUsd, 40)
    assert.equal(state.codingPlans[id].ollama.usage['30d'].requestCount, 0)
    assert.equal(state.codingPlans[id].windows.monthly.percent, 33.33)
    assert.ok(!JSON.stringify(state).includes('PRIVATE'))
  }
  await Promise.all([meter.getState(), meter.getState(), meter.refreshCodingPlan(id), meter.refreshCodingPlan(id)])
  assert.equal(calls.length, 4, 'polling and burst manual refresh share the one-minute cache')
  clock += 61_000
  mode = 'failure'
  const failed = await meter.refreshCodingPlan(id)
  assert.equal(failed.ok, false)
  assert.equal(failed.state.codingPlans[id].status, 'error')
  assert.equal(failed.state.codingPlans[id].ollama.included.balanceUsd, 40, 'transient failure keeps last-good balances')
  assert.equal(failed.state.codingPlans[id].fetchedAt, live.fetchedAt, 'old balances retain their actual timestamp')
  assert.ok(!failed.message.includes('PRIVATE'))
  await meter.getState()
  assert.equal(calls.length, 5, 'a failed query does not restart on every state poll')
  clock += 61_000
  mode = 'limited'
  assert.equal((await meter.refreshCodingPlan(id)).ok, false)
  assert.equal(calls.length, 6)
  clock += 61_000
  await meter.refreshCodingPlan(id)
  assert.equal(calls.length, 6, 'Retry-After also constrains manual refresh')
  clock += 120_000
  mode = 'ok'
  assert.equal((await meter.refreshCodingPlan(id)).ok, true)
  assert.equal(calls.length, 10)

  // 10) usage 部分失败:余额成功 → 整体仍 ok;只缺失败窗口,percent 保持「已用」。
  clock += 61_000
  mode = 'partial'
  const partial = await meter.refreshCodingPlan(id)
  assert.equal(partial.ok, true, partial.message)
  const partialState = partial.state.codingPlans[id]
  assert.deepEqual(Object.keys(partialState.ollama.usage), ['24h', '30d'], 'failed window is absent, not zero')
  assert.equal(partialState.ollama.usage['7d'], undefined)
  assert.equal(partialState.ollama.usageUnavailable, undefined)
  assert.equal(partialState.ollama.included.balanceUsd, 40)
  assert.equal(partialState.windows.monthly.percent, 33.33)
  assert.ok(partial.message.includes('7d'), 'degraded message names the window: ' + partial.message)
  assert.ok(!partial.message.includes('PRIVATE'))
  assert.equal(calls.length, 14)
  assert.doesNotThrow(() => stateSchema.parse(partial.state))

  // 11) usage 全失败:usageUnavailable=true,余额与状态不受影响。
  clock += 61_000
  mode = 'usagefail'
  const usageDown = await meter.refreshCodingPlan(id)
  assert.equal(usageDown.ok, true)
  const usageDownState = usageDown.state.codingPlans[id]
  assert.deepEqual(usageDownState.ollama.usage, {})
  assert.equal(usageDownState.ollama.usageUnavailable, true)
  assert.equal(usageDownState.ollama.included.balanceUsd, 40)
  assert.ok(usageDown.message.includes('24h') && usageDown.message.includes('30d'))
  assert.equal(calls.length, 18)
  assert.doesNotThrow(() => stateSchema.parse(usageDown.state))

  // 12) 401:软失败清空账户数据,不保留上一把 Key / 上一个账户的余额。
  clock += 61_000
  mode = 'unauthorized'
  const unauthorized = await meter.refreshCodingPlan(id)
  assert.equal(unauthorized.ok, false)
  assert.equal(unauthorized.state.codingPlans[id].status, 'off')
  assert.equal(unauthorized.state.codingPlans[id].ollama, undefined)
  assert.ok(unauthorized.message.includes('401'), unauthorized.message)
  assert.ok(!JSON.stringify(unauthorized).includes('PRIVATE'))
  assert.equal(calls.length, 19, 'balance 401 stops before usage')

  // 13) 外部轮换 Key(设置页/其他插件写入 → credentials/reference-updated):
  //     缓存必须失效,新账户数据不得与旧余额混用。
  secrets.set('OLLAMA_API_KEY', 'ROTATED_KEY')
  expectedKey = 'ROTATED_KEY'
  emit('credentials/reference-updated', 'OLLAMA_API_KEY')
  clock += 61_000
  mode = 'rotated'
  const rotated = await meter.refreshCodingPlan(id)
  assert.equal(rotated.ok, true, rotated.message)
  assert.equal(rotated.state.codingPlans[id].ollama.included.balanceUsd, 10, 'new account balance replaces the old one')
  assert.equal(rotated.state.codingPlans[id].windows.monthly.percent, 90)
  assert.equal(calls.length, 23)
  // 其他引用的变化不应动 ollama 缓存:若被误重置,新缓存没有 nextAllowedAt,force 会立刻再发 4 个请求。
  emit('credentials/reference-updated', 'SOME_OTHER_KEY')
  await meter.refreshCodingPlan(id)
  assert.equal(calls.length, 23, 'unrelated credential refs do not invalidate the ollama cache')

  // 14) 外部清除 Key:缓存失效,无 Key 时零请求且不残留旧余额。
  secrets.delete('OLLAMA_API_KEY')
  emit('credentials/reference-updated', 'OLLAMA_API_KEY')
  clock += 61_000
  const cleared = await meter.refreshCodingPlan(id)
  assert.equal(cleared.ok, false)
  assert.equal(cleared.state.codingPlans[id].status, 'off')
  assert.equal(cleared.state.codingPlans[id].ollama, undefined)
  assert.equal(calls.length, 23, 'no request without a key')
  assert.ok(cleared.message.includes('Ollama'), cleared.message)
  // 恢复 Key,继续后面的并发/取消用例。
  secrets.set('OLLAMA_API_KEY', 'PRIVATE_TEST_KEY')
  expectedKey = 'PRIVATE_TEST_KEY'
  emit('credentials/reference-updated', 'OLLAMA_API_KEY')
  clock += 61_000
  mode = 'ok'
  assert.equal((await meter.refreshCodingPlan(id)).ok, true)
  assert.equal(calls.length, 27)

  // 15) 在途去重:轮询与并发手动刷新共享同一次查询,不放大成多个上游请求。
  clock += 61_000
  mode = 'gated'
  gateBalance = balance
  const beforeDedup = calls.length
  const pendingRefresh = meter.refreshCodingPlan(id)
  await until(() => calls.length === beforeDedup + 1)
  const blockedSignal = gateSignal
  assert.equal(blockedSignal.aborted, false)
  const concurrentState = meter.getState()
  const secondRefresh = meter.refreshCodingPlan(id)
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, beforeDedup + 1, 'in-flight query is shared, not restarted')
  mode = 'ok'
  gate.release()
  const [firstResult, secondResult] = await Promise.all([pendingRefresh, secondRefresh])
  await concurrentState
  assert.equal(calls.length, beforeDedup + 4, 'one refresh = balance + 3 usage windows')
  assert.equal(firstResult.state.codingPlans[id].ollama.included.balanceUsd, 40)
  assert.equal(secondResult.ok, true)
  assert.equal(secondResult.state.codingPlans[id].windows.monthly.percent, 33.33)

  // 16) 禁用中止在途请求;晚到的响应不得复活旧账户数据。
  clock += 61_000
  mode = 'gated'
  gateBalance = lateBalance
  const beforeAbort = calls.length
  const pendingAbort = meter.refreshCodingPlan(id)
  await until(() => calls.length === beforeAbort + 1)
  const abortedSignal = gateSignal
  assert.equal(abortedSignal.aborted, false)
  await meter.updateConfig({ codingPlans: { [id]: { enabled: false } } })
  assert.equal(abortedSignal.aborted, true, 'turning the source off aborts the in-flight request')
  mode = 'ok'
  gate.release()
  await pendingAbort
  const offState = await meter.getState()
  assert.equal(offState.codingPlans[id].status, 'off')
  assert.equal(offState.codingPlans[id].ollama, undefined, 'late result never resurrects account data')
  assert.equal(calls.length, beforeAbort + 1, 'no extra request after the abort')

  // 17) 重新启用后手动刷新立即生效(禁用分支留下的 fetchedAt 不阻塞 force)。
  await meter.updateConfig({ codingPlans: { [id]: { enabled: true } } })
  const reenabled = await meter.refreshCodingPlan(id)
  assert.equal(reenabled.ok, true, reenabled.message)
  assert.equal(reenabled.state.codingPlans[id].ollama.included.balanceUsd, 40)
  assert.equal(calls.length, beforeAbort + 5)

  // 18) 关闭来源:清空账户数据,且不再产生请求。
  const beforeOff = calls.length
  await meter.updateConfig({ codingPlans: { [id]: { enabled: false } } })
  const off = await meter.getState()
  assert.equal(off.codingPlans[id].ollama, undefined, 'turning a source off clears its account data')
  assert.equal(calls.length, beforeOff, 'off state makes no request')
  const disk = readFileSync(join(storage, 'ledger.json'), 'utf8')
  assert.ok(!disk.includes('PRIVATE_TEST_KEY'))
  assert.ok(!disk.includes('ROTATED_KEY'))
  assert.ok(!disk.includes('usageUsd'), 'official account history is not written into the session ledger')
} finally {
  globalThis.fetch = originalFetch
  Date.now = originalNow
  for (const dispose of disposers.reverse()) await dispose()
  for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]
  rmSync(root, { recursive: true, force: true })
}
console.log('[ok] Ollama Pro host credentials, codecs, cache, Retry-After, partial usage, in-flight dedupe, abort and last-good account isolation')
