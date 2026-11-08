/**
 * lib/ollama-pro.js 回归:新版 balance / usage 的严格解析、部分降级、429/redirect/认证失败、
 * 取消与凭据不泄露。全部使用合成 fixture 与进程内 fetch 桩,不读真实凭据、不请求真实账户。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OLLAMA_BALANCE_URL, OLLAMA_USAGE_URL, isLegacyOllamaBalance,
  parseOllamaBalance, parseOllamaUsage, queryOllamaPro,
} from '../lib/ollama-pro.js'

// 真实账户的 Key 绝不能出现在这里:任何测试失败都不应把凭据写进日志。
const KEY = 'ollama-PRIVATE-KEY-0123456789'
const BODY_TOKEN = 'PRIVATE_BODY_TOKEN'
const t = (_locale, code) => code

const period = { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' }
const balanceFixture = {
  included: { balance_usd: 72.5, allowance_usd: 100, period },
  purchased: { balance_usd: 25 },
  private: BODY_TOKEN,
}
const legacyFixture = {
  included: {
    session: { remaining_percent: 75, resets_at: '2026-10-01T07:00:00Z' },
    weekly: { remaining_percent: 40, resets_at: '2026-10-05T00:00:00Z' },
  },
  purchased: { balance_usd: 25 },
}
const usageFixture = (range, totals = { request_count: 15, usage_usd: 0.01718, input_tokens: 106000, cached_input_tokens: 46000, output_tokens: 13600 }) => ({
  range, scope: 'self', granularity: range === '24h' ? 'hour' : 'day',
  from: '2026-09-30T02:00:00Z', until: '2026-10-01T02:30:00Z',
  totals, buckets: [{ from: '2026-10-01T02:00:00Z', until: '2026-10-01T02:30:00Z', partial: true, request_count: 3 }],
})

// ── 1. balance 解析 ───────────────────────────────────────────────────────
assert.deepEqual(parseOllamaBalance(balanceFixture), {
  included: { balanceUsd: 72.5, allowanceUsd: 100, periodFrom: '2026-09-15T09:30:00.000Z', periodUntil: '2026-10-15T09:30:00.000Z' },
  purchasedBalanceUsd: 25,
})
// 零余额是有效数据,不是缺失;总额 0 也照样解析(比例在查询层才判定不可得)。
assert.deepEqual(parseOllamaBalance({ included: { balance_usd: 0, allowance_usd: 100, period }, purchased: { balance_usd: 0 } }),
  { included: { balanceUsd: 0, allowanceUsd: 100, periodFrom: '2026-09-15T09:30:00.000Z', periodUntil: '2026-10-15T09:30:00.000Z' }, purchasedBalanceUsd: 0 })
assert.equal(parseOllamaBalance({ included: { balance_usd: 0, allowance_usd: 0, period }, purchased: { balance_usd: 0 } }).included.allowanceUsd, 0)
// 未知字段忽略,不影响解析。
assert.deepEqual(Object.keys(parseOllamaBalance(balanceFixture)), ['included', 'purchasedBalanceUsd'])
assert.deepEqual(Object.keys(parseOllamaBalance(balanceFixture).included), ['balanceUsd', 'allowanceUsd', 'periodFrom', 'periodUntil'])

// legacy 套餐:明确不支持,解析返回 null(不猜百分比,不映射成美元余额)。
assert.equal(parseOllamaBalance(legacyFixture), null)
assert.equal(isLegacyOllamaBalance(legacyFixture), true)
assert.equal(isLegacyOllamaBalance(balanceFixture), false)
assert.equal(isLegacyOllamaBalance({ included: { session: { remaining_percent: 75 } }, purchased: {} }), true)
assert.equal(isLegacyOllamaBalance({ included: { weekly: {} } }), true)
assert.equal(isLegacyOllamaBalance(null), false)
assert.equal(isLegacyOllamaBalance('legacy'), false)
// 新版字段优先:同时出现 session/weekly 时按新版解析。
assert.equal(isLegacyOllamaBalance({ included: { ...balanceFixture.included, session: legacyFixture.included.session } }), false)
assert.equal(parseOllamaBalance({ included: { ...balanceFixture.included, session: legacyFixture.included.session }, purchased: { balance_usd: 1 } }).purchasedBalanceUsd, 1)

// 结构无效一律 null:缺失、字符串、NaN、负数、倒置周期、非 ISO 时刻。
for (const bad of [null, undefined, 'x', 42, [], {}, { included: null }, { purchased: { balance_usd: 1 } }]) {
  assert.equal(parseOllamaBalance(bad), null, `无效 balance 拒绝:${JSON.stringify(bad)}`)
}
const withIncluded = patch => ({ included: { ...balanceFixture.included, ...patch }, purchased: balanceFixture.purchased })
for (const field of ['balance_usd', 'allowance_usd']) {
  for (const value of ['72.5', null, NaN, Infinity, -1, true]) {
    assert.equal(parseOllamaBalance(withIncluded({ [field]: value })), null, `${field} 非有限非负数值拒绝:${String(value)}`)
  }
}
assert.equal(parseOllamaBalance(withIncluded({ balance_usd: undefined })), null, '缺 balance_usd 不被当作零')
assert.equal(parseOllamaBalance(withIncluded({ period: undefined })), null, '缺 period 拒绝')
assert.equal(parseOllamaBalance(withIncluded({ period: { from: period.until, until: period.from } })), null, '倒置周期拒绝')
assert.equal(parseOllamaBalance(withIncluded({ period: { from: period.from, until: period.from } })), null, '零长周期拒绝')
for (const from of ['2026-09-15', 'yesterday', 1757928600000, '2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-09-15T24:00:00Z', '2026-09-15T09:30:00']) {
  assert.equal(parseOllamaBalance(withIncluded({ period: { from, until: period.until } })), null, `非 ISO 时刻拒绝:${String(from)}`)
}
assert.equal(parseOllamaBalance({ included: balanceFixture.included }), null, '缺 purchased 拒绝')
assert.equal(parseOllamaBalance({ included: balanceFixture.included, purchased: {} }), null, 'purchased 缺 balance_usd 拒绝')
assert.equal(parseOllamaBalance({ included: balanceFixture.included, purchased: { balance_usd: -0.01 } }), null, 'purchased 负数拒绝')
assert.ok(parseOllamaBalance({ included: balanceFixture.included, purchased: { balance_usd: 0 } }), 'purchased 0 有效')
// 闰年 2 月 29 日有效,时区偏移按 UTC 规范化。
assert.equal(parseOllamaBalance({ included: { ...balanceFixture.included, period: { from: '2024-02-29T00:00:00Z', until: '2024-03-01T00:00:00Z' } }, purchased: { balance_usd: 0 } }).included.periodFrom, '2024-02-29T00:00:00.000Z')
assert.equal(parseOllamaBalance({ included: { ...balanceFixture.included, period: { from: '2026-09-15T09:30:00+08:00', until: period.until } }, purchased: { balance_usd: 0 } }).included.periodFrom, '2026-09-15T01:30:00.000Z')

// ── 2. usage 解析 ────────────────────────────────────────────────────────
assert.deepEqual(parseOllamaUsage(usageFixture('24h'), '24h'), {
  from: '2026-09-30T02:00:00.000Z', until: '2026-10-01T02:30:00.000Z',
  requestCount: 15, usageUsd: 0.01718, inputTokens: 106000, cachedInputTokens: 46000, outputTokens: 13600,
})
// 总额为 0 必须保留 0(而不是被当成缺失)。
const zeroTotals = parseOllamaUsage(usageFixture('7d', { request_count: 0, usage_usd: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }), '7d')
assert.deepEqual(zeroTotals, { from: '2026-09-30T02:00:00.000Z', until: '2026-10-01T02:30:00.000Z', requestCount: 0, usageUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
// 缺字段不当零:键直接不出现。
const bare = parseOllamaUsage(usageFixture('30d', { request_count: 4 }), '30d')
assert.deepEqual(bare, { from: '2026-09-30T02:00:00.000Z', until: '2026-10-01T02:30:00.000Z', requestCount: 4 })
assert.deepEqual(Object.keys(bare), ['from', 'until', 'requestCount'])
assert.equal('usageUsd' in bare, false)
// 显式 null 表示未知,同样不当作 0。
assert.deepEqual(Object.keys(parseOllamaUsage(usageFixture('24h', { request_count: 1, usage_usd: null }), '24h')), ['from', 'until', 'requestCount'])
// buckets/groups/scope/granularity 不参与 totals 解析,存在与否不影响结果。
assert.deepEqual(parseOllamaUsage({ ...usageFixture('24h'), buckets: 'garbage', groups: [null] }, '24h'), parseOllamaUsage(usageFixture('24h'), '24h'))
// range 是窗口标签:自报值不一致必须拒绝;整体缺失可接受。
assert.equal(parseOllamaUsage(usageFixture('7d'), '24h'), null)
assert.equal(parseOllamaUsage(usageFixture('24h'), '1h'), null)
assert.equal(parseOllamaUsage({ ...usageFixture('24h'), range: undefined }, '24h').requestCount, 15)
// 计数必须是整数,金额/Token 必须是有限非负数;存在但非法 ⇒ 整窗无效(不静默丢字段)。
for (const value of ['15', NaN, Infinity, -1, 1.5]) {
  assert.equal(parseOllamaUsage(usageFixture('24h', { request_count: value }), '24h'), null, `request_count 非法拒绝:${String(value)}`)
}
for (const field of ['usage_usd', 'input_tokens', 'cached_input_tokens', 'output_tokens']) {
  for (const value of ['0.1', NaN, Infinity, -0.1]) {
    assert.equal(parseOllamaUsage(usageFixture('24h', { request_count: 1, [field]: value }), '24h'), null, `${field} 非法拒绝:${String(value)}`)
  }
}
assert.equal(parseOllamaUsage(usageFixture('24h', { request_count: 1, input_tokens: 1.5 }), '24h'), null, 'Token 计数必须为整数')
for (const bad of [null, 'x', {}, { totals: {} }, { totals: null, from: 'a', until: 'b' }, { from: 'a', until: 'b', totals: { request_count: 1 } }]) {
  assert.equal(parseOllamaUsage(bad, '24h'), null, `无效 usage 拒绝:${JSON.stringify(bad)}`)
}
assert.equal(parseOllamaUsage({ ...usageFixture('24h'), totals: undefined }, '24h'), null, '缺 totals 拒绝')
assert.equal(parseOllamaUsage({ ...usageFixture('24h'), until: usageFixture('24h').from }, '24h').requestCount, 15, 'from == until 容忍(零长窗口不制造失败)')
assert.equal(parseOllamaUsage({ ...usageFixture('24h'), until: '2026-09-01T00:00:00Z' }, '24h'), null, 'from > until 拒绝')

// ── 3. 查询:正常路径、并行、请求形状 ───────────────────────────────────
const originalFetch = globalThis.fetch
const calls = []
let routes = new Map()
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init })
  const hit = [...routes].find(([prefix]) => String(url).startsWith(prefix))
  if (!hit) throw new Error(`unexpected fetch: ${String(url)}`)
  return hit[1](String(url), init)
}
const routeOk = () => {
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
    [OLLAMA_USAGE_URL, (url) => Response.json(usageFixture(new URL(url).searchParams.get('range')))],
  ])
  calls.length = 0
}
const rejectsWith = async (promise, { code, status, retryAfterMs, soft, message }) => {
  let error
  try { await promise } catch (caught) { error = caught }
  assert.ok(error instanceof Error, `应以 ${code} 拒绝`)
  if (code !== undefined) assert.equal(error.code, code)
  if (status !== undefined) assert.equal(error.status, status)
  if (retryAfterMs !== undefined) assert.equal(error.retryAfterMs, retryAfterMs)
  if (soft !== undefined) assert.equal(error.soft, soft)
  if (message !== undefined) assert.equal(error.message, message)
  return error
}
// 等待异步链路推进到条件成立,避免用固定 tick 数猜时序。
const until = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('等待条件超时')
}
const leakCheck = []

try {
  // 3.1) 三个 usage 的并行性:必须三个都在途,否则这里会死等(超时兜底)。
  let arrived = 0
  let openGate
  const gate = new Promise(resolve => { openGate = resolve })
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
    [OLLAMA_USAGE_URL, async (url) => {
      arrived++
      if (arrived === 3) openGate()
      await gate
      return Response.json(usageFixture(new URL(url).searchParams.get('range')))
    }],
  ])
  calls.length = 0
  let timer
  const watchdog = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('usage 查询未并行(3 个窗口未同时在途)')), 4000) })
  let result
  try { result = await Promise.race([queryOllamaPro(KEY, 'zh', t), watchdog]) } finally { clearTimeout(timer) }
  assert.equal(arrived, 3, '三个 usage 窗口各请求一次')
  assert.deepEqual(result, {
    windows: { monthly: { percent: 27.5, resetsAt: '2026-10-15T09:30:00.000Z' } },
    ollama: {
      included: { balanceUsd: 72.5, allowanceUsd: 100, periodFrom: '2026-09-15T09:30:00.000Z', periodUntil: '2026-10-15T09:30:00.000Z' },
      purchasedBalanceUsd: 25,
      usage: {
        '24h': parseOllamaUsage(usageFixture('24h'), '24h'),
        '7d': parseOllamaUsage(usageFixture('7d'), '7d'),
        '30d': parseOllamaUsage(usageFixture('30d'), '30d'),
      },
    },
    endpoint: OLLAMA_BALANCE_URL,
  })
  assert.equal('message' in result, false, '全部成功时不产生提示')
  assert.equal('retryAfterMs' in result, false)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, '结果可直接 JSON 序列化(无 undefined 值)')

  // 3.2) 请求形状:固定官方域名、GET 无 body、manual redirect、凭据只在 Authorization 头。
  const urls = calls.map(call => call.url).sort()
  assert.deepEqual(urls, [OLLAMA_BALANCE_URL, `${OLLAMA_USAGE_URL}?range=24h`, `${OLLAMA_USAGE_URL}?range=30d`, `${OLLAMA_USAGE_URL}?range=7d`].sort())
  for (const { url, init } of calls) {
    assert.ok(url.startsWith('https://ollama.com/api/'), `只请求官方域名:${url}`)
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.authorization, `Bearer ${KEY}`)
    assert.equal(init.headers.accept, 'application/json')
    assert.equal(init.headers['accept-encoding'], 'identity')
  }
  assert.ok(calls.every(call => !call.url.includes(KEY)), 'Key 不进 URL')

  // 3.3) 额度必须成功:balance 失败即使 usage 可能可用也直接报错,不请求 usage。
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => new Response('{}', { status: 500 })],
    [OLLAMA_USAGE_URL, () => { throw new Error('usage 不应被请求') }],
  ])
  calls.length = 0
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaHttp', status: 500 })
  assert.equal(calls.length, 1, 'balance 失败即止')

  // 3.4) 额度 0 / 总额 0:零余额不是错误,总额 0 时不给百分比。
  routeOk()
  routes.set(OLLAMA_BALANCE_URL, () => Response.json({ included: { balance_usd: 0, allowance_usd: 100, period }, purchased: { balance_usd: 0 } }))
  const usedUp = await queryOllamaPro(KEY, 'zh', t)
  assert.equal(usedUp.windows.monthly.percent, 100, '余额 0 视为已用 100%')
  assert.equal(usedUp.windows.monthly.resetsAt, '2026-10-15T09:30:00.000Z')
  assert.equal(usedUp.ollama.included.balanceUsd, 0)
  assert.equal(usedUp.ollama.purchasedBalanceUsd, 0)
  routes.set(OLLAMA_BALANCE_URL, () => Response.json({ included: { balance_usd: 0, allowance_usd: 0, period }, purchased: { balance_usd: 0 } }))
  const noAllowance = await queryOllamaPro(KEY, 'zh', t)
  assert.deepEqual(noAllowance.windows.monthly, { resetsAt: '2026-10-15T09:30:00.000Z' }, '总额 0 时不编造百分比')
  routes.set(OLLAMA_BALANCE_URL, () => Response.json({ included: { balance_usd: 5, allowance_usd: 0, period }, purchased: { balance_usd: 0 } }))
  assert.equal((await queryOllamaPro(KEY, 'zh', t)).windows.monthly.percent, undefined, '总额 0 且余额异常时仍不猜测')

  // 3.5) usage 部分失败:保留余额,只缺失败窗口,并给出不泄露细节的提示。
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
    [OLLAMA_USAGE_URL, (url) => new URL(url).searchParams.get('range') === '7d'
      ? new Response(BODY_TOKEN, { status: 500 })
      : Response.json(usageFixture(new URL(url).searchParams.get('range')))],
  ])
  const partial = await queryOllamaPro(KEY, 'zh', t)
  assert.deepEqual(Object.keys(partial.ollama.usage), ['24h', '30d'], '失败窗口不出现(缺失≠0)')
  assert.equal(partial.ollama.usageUnavailable, undefined)
  assert.equal(partial.windows.monthly.percent, 27.5, '余额不受 usage 部分失败影响')
  assert.ok(partial.message.includes('7d') && partial.message.includes('HTTP 500'), '提示指出失败窗口与原因')
  assert.ok(!partial.message.includes(BODY_TOKEN) && !partial.message.includes(KEY), '提示不回显响应体与 Key')
  leakCheck.push(partial.message)
  assert.equal('retryAfterMs' in partial, false)
  // 英文文案。
  const partialEn = await queryOllamaPro(KEY, 'en', t)
  assert.ok(/Some Ollama usage windows are unavailable/.test(partialEn.message) && partialEn.message.includes('7d'), '英文降级文案')

  // 3.6) usage 429:把 Retry-After 交给父级,自己不长 sleep。
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
    [OLLAMA_USAGE_URL, (url) => new URL(url).searchParams.get('range') === '24h'
      ? new Response(BODY_TOKEN, { status: 429, headers: { 'retry-after': '42' } })
      : Response.json(usageFixture(new URL(url).searchParams.get('range')))],
  ])
  const startedAt = Date.now()
  const limited = await queryOllamaPro(KEY, 'zh', t)
  assert.ok(Date.now() - startedAt < 1000, '不按 Retry-After 睡眠重试')
  assert.equal(limited.retryAfterMs, 42000, 'usage 429 的 Retry-After 透出给父级')
  assert.deepEqual(Object.keys(limited.ollama.usage), ['7d', '30d'])
  assert.ok(limited.message.includes('请求过于频繁') && limited.message.includes('42'), '提示带重试秒数')
  leakCheck.push(limited.message)
  // 合法的小时级 Retry-After:原样交给父级,提示不渲染几十万秒。
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
    [OLLAMA_USAGE_URL, (url) => new URL(url).searchParams.get('range') === '24h'
      ? new Response('', { status: 429, headers: { 'retry-after': '7200' } })
      : Response.json(usageFixture(new URL(url).searchParams.get('range')))],
  ])
  const longWait = await queryOllamaPro(KEY, 'zh', t)
  assert.equal(longWait.retryAfterMs, 7_200_000, 'usage 429 的长 Retry-After 原样透出')
  assert.ok(!longWait.message.includes('7200'), '超过一小时不渲染秒数')
  assert.ok(longWait.message.includes('稍后重试'), '改用「稍后重试」提示')
  leakCheck.push(longWait.message)

  // 3.7) usage 全部失败:usageUnavailable 且余额仍可用。
  routes = new Map([
    [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
    [OLLAMA_USAGE_URL, () => new Response(BODY_TOKEN, { status: 401 })],
  ])
  const unavailable = await queryOllamaPro(KEY, 'zh', t)
  assert.deepEqual(unavailable.ollama.usage, {})
  assert.equal(unavailable.ollama.usageUnavailable, true)
  assert.equal(unavailable.ollama.purchasedBalanceUsd, 25)
  assert.ok(unavailable.message.includes('24h') && unavailable.message.includes('30d'), '全失败列出全部窗口')
  assert.ok(unavailable.message.includes('凭据无效'), '按失败类别给出原因')
  assert.ok(!unavailable.message.includes(BODY_TOKEN))
  leakCheck.push(unavailable.message)
  // 3.8) 未提供 t / 非 en 语言:回落到本模块内置中文文案,不崩也不漏出内部 code。
  const withoutT = await queryOllamaPro(KEY, 'zh')
  assert.equal(withoutT.ollama.usageUnavailable, true)
  assert.ok(withoutT.message.includes('用量') && !withoutT.message.includes('ollamaUsageUnavailable'), '未传 t 时使用内置文案')
  const frLocale = await queryOllamaPro(KEY, 'fr', t)
  assert.ok(frLocale.message.includes('用量'), '非 en 语言按 zh 处理')
} finally {
  globalThis.fetch = originalFetch
}
// 上面 finally 已恢复全局 fetch,其余查询继续用本地桩。
const withRoutes = async (handlers, run) => {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const hit = [...handlers].find(([prefix]) => String(url).startsWith(prefix))
    if (!hit) throw new Error(`unexpected fetch: ${String(url)}`)
    return hit[1](String(url), init)
  }
  try { return await run() } finally { globalThis.fetch = originalFetch }
}

// ── 4. balance 失败分类 ──────────────────────────────────────────────────
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response(BODY_TOKEN, { status: 401 })]], async () => {
  calls.length = 0
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaUnauthorized', status: 401, soft: true })
  assert.ok(error.message.includes('401') && !error.message.includes(KEY) && !error.message.includes(BODY_TOKEN), '认证失败文案不回显凭据/响应体')
  leakCheck.push(error.message)
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 403 })]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'en', t), { code: 'ollamaUnauthorized', status: 403, soft: true })
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response(BODY_TOKEN, { status: 429, headers: { 'retry-after': '30' } })]], async () => {
  assert.equal((await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRateLimited', status: 429 })).retryAfterMs, 30000)
  assert.equal((await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRateLimited' })).retryAfterMs, 30000)
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 429 })]], async () => {
  assert.equal((await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRateLimited' })).retryAfterMs, 0, '缺 Retry-After 时为 0(未知)')
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2099 07:28:00 GMT' } })]], async () => {
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRateLimited' })
  const target = Date.parse('Wed, 21 Oct 2099 07:28:00 GMT')
  assert.ok(Math.abs(error.retryAfterMs - (target - Date.now())) < 10_000, 'HTTP 日期原样换算,不截断到更早时刻')
  assert.ok(error.retryAfterMs > 600000, '合法长等待不被 10 分钟上限缩短')
})
// 合法的小时级 delay-seconds 原样透出;只有溢出的不可表示值才饱和(方向永远更晚)。
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 429, headers: { 'retry-after': '7200' } })]], async () => {
  assert.equal((await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRateLimited' })).retryAfterMs, 7_200_000)
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 429, headers: { 'retry-after': '9'.repeat(30) } })]], async () => {
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRateLimited' })
  assert.equal(error.retryAfterMs, Number.MAX_SAFE_INTEGER, '不可表示的溢出值饱和,而不是静默提前')
  assert.equal(Number.isFinite(error.retryAfterMs), true, '父级 Number.isFinite 分支仍可用')
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 503 })]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaServiceUnavailable', status: 503 })
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 418 })]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaHttp', status: 418 })
})
// 重定向:拒绝跟随,凭据不会发到 Location 指向的主机。
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('', { status: 302, headers: { location: 'https://exfil.invalid/collect' } })]], async () => {
  calls.length = 0
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRedirect', status: 302 })
  assert.equal(calls.length, 1, '不跟随重定向')
  assert.ok(calls.every(call => call.url === OLLAMA_BALANCE_URL))
  assert.ok(!error.message.includes('exfil'), '文案不泄露 Location')
  leakCheck.push(error.message)
})
// 浏览器 manual redirect 的不透明响应(status 0)同等拒绝。
await withRoutes([[OLLAMA_BALANCE_URL, () => ({ ok: false, status: 0, headers: { get: () => null }, body: { cancel: async () => {} } })]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaRedirect', status: 0 })
})
// 坏 JSON / 形状不符 / 超大响应:统一解析错误,不回显响应正文。
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response(BODY_TOKEN, { headers: { 'content-type': 'application/json' } })]], async () => {
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaBadPayload' })
  assert.ok(!error.message.includes(BODY_TOKEN) && !error.message.includes(KEY))
  leakCheck.push(error.message)
})
await withRoutes([[OLLAMA_BALANCE_URL, () => Response.json({ included: { session: {} }, purchased: { balance_usd: 1 } })]], async () => {
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaLegacyUnsupported', soft: true })
  assert.ok(error.message.includes('旧版套餐') && error.message.includes('session'), 'legacy 明确报不支持')
  leakCheck.push(error.message)
})
await withRoutes([[OLLAMA_BALANCE_URL, () => Response.json({ included: { balance_usd: 1 }, purchased: { balance_usd: 1 } })]], async () => {
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaInvalidShape' })
  assert.ok(error.message.includes('未将其视为零余额'))
  leakCheck.push(error.message)
})
await withRoutes([[OLLAMA_BALANCE_URL, () => Response.json({ included: balanceFixture.included })]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaInvalidShape' })
})
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response('x'.repeat(200000))]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaBadPayload' })
})
// 网络瞬时错误重试后仍失败 ⇒ ollamaNetwork,文案不含底层错误。
let networkCalls = 0
await withRoutes([[OLLAMA_BALANCE_URL, () => { networkCalls++; throw new TypeError('fetch failed: PRIVATE_INTERNAL') }]], async () => {
  const error = await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaNetwork' })
  assert.equal(networkCalls, 2, '瞬时网络错误重试一次(attempts: 2)')
  assert.ok(!error.message.includes('PRIVATE_INTERNAL'))
  leakCheck.push(error.message)
})

// ── 5. 凭据处理:缺失/非法不发起请求,且不泄露 ───────────────────────────
await withRoutes([[OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)]], async () => {
  calls.length = 0
  await rejectsWith(queryOllamaPro('', 'zh', t), { code: 'ollamaKeyMissing', soft: true })
  await rejectsWith(queryOllamaPro('   ', 'en', t), { code: 'ollamaKeyMissing', soft: true })
  await rejectsWith(queryOllamaPro(null, 'zh', t), { code: 'ollamaKeyMissing' })
  await rejectsWith(queryOllamaPro(`${KEY}\r\nx-injected: 1`, 'zh', t), { code: 'ollamaKeyInvalid', soft: true })
  await rejectsWith(queryOllamaPro(`${KEY} extra`, 'zh', t), { code: 'ollamaKeyInvalid' })
  await rejectsWith(queryOllamaPro('k'.repeat(513), 'zh', t), { code: 'ollamaKeyInvalid' })
  assert.equal(calls.length, 0, '凭据缺失/非法时不发起请求')
  // 宿主文案可覆盖本模块文案(已注册的 code)。
  const custom = await rejectsWith(queryOllamaPro('', 'zh', (_locale, code) => code === 'ollamaKeyMissing' ? 'CUSTOM_KEY_MESSAGE' : code), { code: 'ollamaKeyMissing' })
  assert.equal(custom.message, 'CUSTOM_KEY_MESSAGE')
})

// ── 6. 取消与响应体释放 ──────────────────────────────────────────────────
await withRoutes([[OLLAMA_BALANCE_URL, (url, init) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
})]], async () => {
  calls.length = 0
  const controller = new AbortController()
  const pending = queryOllamaPro(KEY, 'zh', t, { signal: controller.signal })
  await until(() => calls.length >= 1)
  assert.equal(calls.length, 1)
  assert.notEqual(calls[0].init.signal, controller.signal, '请求信号是调用方信号与超时信号的组合')
  const reason = new Error('CANCELLED_BY_PARENT')
  controller.abort(reason)
  let caught
  try { await pending } catch (error) { caught = error }
  assert.equal(caught, reason, '取消原因原样冒泡')
  assert.equal(calls[0].init.signal.aborted, true, '组合信号随调用方一起中止')
})
await withRoutes([
  [OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)],
  [OLLAMA_USAGE_URL, (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })],
], async () => {
  calls.length = 0
  const controller = new AbortController()
  const pending = queryOllamaPro(KEY, 'zh', t, { signal: controller.signal })
  await until(() => calls.length >= 2)
  controller.abort(new Error('CANCELLED_DURING_USAGE'))
  await assert.rejects(pending, /CANCELLED_DURING_USAGE/, 'usage 阶段取消不被降级吞掉')
})
// 已取消的信号:一次请求都不发。
await withRoutes([[OLLAMA_BALANCE_URL, () => Response.json(balanceFixture)]], async () => {
  calls.length = 0
  const controller = new AbortController()
  const reason = new Error('ALREADY_ABORTED')
  controller.abort(reason)
  await assert.rejects(queryOllamaPro(KEY, 'zh', t, { signal: controller.signal }), error => error === reason)
  assert.equal(calls.length, 0)
})
// 错误响应必须释放 body(否则 keep-alive 连接被占住)。
let bodyCancelled = false
await withRoutes([[OLLAMA_BALANCE_URL, () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode(BODY_TOKEN)) },
  cancel() { bodyCancelled = true },
}), { status: 500 })]], async () => {
  await rejectsWith(queryOllamaPro(KEY, 'zh', t), { code: 'ollamaHttp', status: 500 })
  assert.equal(bodyCancelled, true, '错误响应体被取消')
})

// ── 7. 与账本隔离 + 导出面 ──────────────────────────────────────────────
const source = readFileSync(new URL('../lib/ollama-pro.js', import.meta.url), 'utf8')
assert.ok(!/from '\.\/(store|ledger-[a-z-]+|backfill|billing-[a-z-]+)\.js'/.test(source), '不导入账本/计费模块')
assert.ok(!/\bLedger\b|\bwriteLedger\b|\.days\b/.test(source), '源码不含账本写入路径')
assert.deepEqual(Object.keys(await import('../lib/ollama-pro.js')).sort(),
  ['OLLAMA_BALANCE_URL', 'OLLAMA_USAGE_URL', 'isLegacyOllamaBalance', 'parseOllamaBalance', 'parseOllamaUsage', 'queryOllamaPro'])
assert.equal(OLLAMA_BALANCE_URL, 'https://ollama.com/api/balance')
assert.equal(OLLAMA_USAGE_URL, 'https://ollama.com/api/usage')
assert.ok(leakCheck.every(message => !message.includes(KEY) && !message.includes(BODY_TOKEN)), '所有对外文案都不含 Key/响应体')

console.log('[ok] Ollama Pro 额度:新版 balance/usage 严格解析、部分降级、429/redirect/认证、取消与凭据不泄露')
