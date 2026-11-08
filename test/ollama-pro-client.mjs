/**
 * Ollama Cloud / Ollama Pro 客户端回归(合成数据,不启动浏览器、不访问网络)。
 *
 * 契约:provider id 'ollama-cloud'(与本地推理 provider 'ollama' 无关);
 * 额度快照沿用通用 codingPlans 结构,新增可选 .ollama:
 *   { included: { balanceUsd(剩余), allowanceUsd(月度总额), periodFrom, periodUntil },
 *     purchasedBalanceUsd, usage: { '24h'|'7d'|'30d': { requestCount, usageUsd?, inputTokens?, ... } },
 *     usageUnavailable? }
 * 只展示 windows.monthly(新版);不解析旧版 session/weekly。金额走 formatMoneyUsd(state.config),
 * 0 照常显示,缺失显示 —。失败但保留旧数据时必须提示可能过期。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'
import { sanitizeConfig } from '../lib/store.js'

const clientDir = new URL('../src/client/', import.meta.url)
const source = readdirSync(clientDir).filter(name => name.endsWith('.js')).sort()
  .map(name => readFileSync(new URL(name, clientDir), 'utf8')).join('')

// 只挂载需要的组件/纯函数;不读取 lib/client.js(构建产物由父级统一生成)。
const expose = [
  'CODING_PLAN_ROWS', 'parseConfig', 'parseState', 'makeT', 'resolveLocale',
  'formatMoneyUsd', 'billingClassOfLocal', 'planProviderIdOfLocal',
  'renderSidebarFooter', 'QuotaStrip', 'QuotaCard', 'useQuotaRefresh', 'MiniMaxPlanCard',
  'barDirectionOf', 'quotaWindowRow', 'codingPlanWindowLabel', 'codingPlanWindowEntries',
  'numInput', 'CredentialField', 'quotaPlacementValue', 'quotaPlacementPatch', 'quotaPlacementOptions',
]
let mainFactory
vm.runInNewContext(source.replace('exports.apply = apply',
  `exports.test = { ${expose.join(', ')} }; exports.__messages = MESSAGES; exports.apply = apply`), {
  URL, Date,
  navigator: { language: 'en' },
  document: { querySelector: () => ({}), addEventListener() {}, removeEventListener() {} },
  window: {
    __ModuleLoader__: { load: value => { mainFactory = value.factory } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  },
})

const el = (type, props, ...children) => ({ type, props: props ?? {}, children })
let active = null
const React = {
  createElement: el,
  Fragment: 'fragment',
  useState(initial) {
    const owner = active, index = owner.cursor++
    owner.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial }
    return [owner.hooks[index].value, update => {
      owner.hooks[index].value = typeof update === 'function' ? update(owner.hooks[index].value) : update
    }]
  },
  useRef(value) {
    const owner = active, index = owner.cursor++
    return owner.hooks[index] ??= { current: value }
  },
  useEffect() { active.cursor++ },
}
const main = mainFactory(name => name === 'react' ? React : { Tooltip: 'tooltip' })
const ui = main.test

function renderComponent(component, props) {
  const owner = { hooks: [], cursor: 0 }
  const previous = active
  active = owner
  let tree
  try { tree = component(props) } finally { active = previous }
  return tree
}
function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(renderComponent(node.type, node.props))
  return { ...node, children: (node.children ?? []).map(expand) }
}
const nodes = value => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === 'object' ? [value, ...nodes(value.children ?? [])] : []
const text = value => Array.isArray(value) ? value.map(text).join(' ')
  : value && typeof value === 'object' ? text(value.children ?? []) : value == null ? '' : String(value)
const byProp = (tree, key, value) => nodes(tree).find(node => node.props?.[key] === value)
const cellOf = (tree, label) => nodes(tree).find(node => node.type === 'div'
  && node.props?.style?.borderRadius === 6 && text(node.children?.[0]) === label)
const cellValue = (tree, label) => {
  const cell = cellOf(tree, label)
  assert.ok(cell, '缺少明细格: ' + label)
  return text(nodes(cell).find(node => node.type === 'strong'))
}
const cellSub = (tree, label) => {
  const smalls = nodes(cellOf(tree, label)).filter(node => node.type === 'small')
  return smalls.length > 1 ? text(smalls[1]) : ''
}

// ── 1. 厂商行、双语字典与默认计费类 ─────────────────────────────────────────
const row = ui.CODING_PLAN_ROWS.find(item => item.id === 'ollama-cloud')
assert.ok(row, 'CODING_PLAN_ROWS 含额度适配器 ollama-cloud')
assert.equal(row.labelKey, 'codingPlanOllama')
assert.equal(ui.CODING_PLAN_ROWS.some(item => item.id === 'ollama'), false, '本地 ollama 不作为订阅行出现')
// 主 client 字典只保留厂商名(其余明细文案放按需 chunk,避免主产物字节膨胀)。
for (const key of ['codingPlanOllama']) {
  assert.equal(typeof main.__messages.zh[key], 'string', 'zh 字典缺 ' + key)
  assert.equal(typeof main.__messages.en[key], 'string', 'en 字典缺 ' + key)
}
assert.match(main.__messages.zh.codingPlanOllama, /Ollama/)
assert.match(main.__messages.en.codingPlanOllama, /Ollama/)

const base = sanitizeConfig({
  locale: 'zh', currency: 'USD', symbol: '$', exchangeRate: 1, decimals: 2, historyDays: 90,
  sidebar: false, hideTodayCost: true, hideOfficialBalance: true,
  goQuota: { enabled: false, display: 'off' }, budget: { enabled: false }, balance: { display: 'off' },
  sidebarModels: { enabled: false }, peakEnabled: false, peakNotice: false,
  codingPlans: { 'ollama-cloud': { enabled: true, display: 'settings', refreshMinutes: 30, apiKey: '' } },
})
const config = ui.parseConfig(base, 'config')
assert.equal(config.codingPlans['ollama-cloud'].enabled, true)
assert.equal(config.codingPlans['ollama-cloud'].refreshMinutes, 30)
// 宿主默认 class 的客户端镜像:即使额度查询已启用、配置里没有显式归类,仍是按量计费。
const noClass = ui.parseConfig({ ...base, planBilling: { providers: {}, models: {}, modelPlans: {} } }, 'config')
assert.equal(ui.billingClassOfLocal('ollama-cloud', 'deepseek-v4-pro', noClass), 'api', '额度查询开关不把 ollama-cloud 归为订阅')
assert.equal(ui.billingClassOfLocal('ollama', 'llama3.1', noClass), 'api', '本地 ollama 仍是按量计费')
assert.equal(ui.planProviderIdOfLocal('ollama', noClass, 'llama3.1'), null, '本地 ollama 没有套餐 id')
assert.equal(ui.planProviderIdOfLocal('ollama-cloud', noClass, 'deepseek-v4-pro'), 'ollama-cloud')

const day = { date: '2026-11-08', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, byModel: {}, byProviderModel: {} }
const fetchedAt = Date.parse('2026-11-08T10:00:00Z')
const live = {
  enabled: true, display: 'settings', refreshMinutes: 30, apiKey: '', keyConfigured: true, keySource: 'credential',
  status: 'ok', message: '', fetchedAt,
  windows: { monthly: { percent: 25, resetsAt: '2026-12-01T00:00:00.000Z' } },
  ollama: {
    included: {
      balanceUsd: 75, allowanceUsd: 100,
      periodFrom: '2026-11-01T00:00:00.000Z', periodUntil: '2026-12-01T00:00:00.000Z',
    },
    purchasedBalanceUsd: 5,
    usage: {
      '24h': { from: '2026-11-07T10:00:00.000Z', until: '2026-11-08T10:00:00.000Z', requestCount: 12, usageUsd: 1.25, inputTokens: 1200, cachedInputTokens: 200, outputTokens: 300 },
      '7d': { from: '2026-11-01T10:00:00.000Z', until: '2026-11-08T10:00:00.000Z', requestCount: 0, usageUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      '30d': { from: '2026-10-09T10:00:00.000Z', until: '2026-11-08T10:00:00.000Z', requestCount: 99 },
    },
  },
}
const fullState = { today: day, month: day, total: day, config, codingPlans: { 'ollama-cloud': live }, history: [], meta: { now: fetchedAt, timezoneOffsetMinutes: 0 } }

// ── 2. state 校验器保留 .ollama(不做字段裁剪) ─────────────────────────────
const parsed = ui.parseState(fullState, 'state')
assert.deepEqual(JSON.parse(JSON.stringify(parsed.codingPlans['ollama-cloud'].ollama)), live.ollama, 'state 校验器保留 .ollama 明细')
assert.equal(parsed.codingPlans['ollama-cloud'].windows.monthly.percent, 25)

// ── 3. 设置页额度卡片:月度总额 / 已用 / 剩余 / 购买余额 / 重置 / 用量区间 ──
let plansFactory
vm.runInNewContext(readFileSync(new URL('../src/plan-settings/index.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load: value => { plansFactory = value.factory } } }, URL, Date,
})
const planPage = plansFactory(name => name === 'react' ? React : {}).mount(ui)
const t = ui.makeT('zh')
const renderPlan = (props = {}) => expand(planPage({
  planId: 'ollama-cloud', labelKey: 'codingPlanOllama', state: fullState, t,
  draft: config, setDraft: () => {}, targeted: false, ...props,
}))
const card = renderPlan()
const detail = byProp(card, 'data-cm-ollama', 'detail')
assert.ok(detail, '额度卡片包含 Ollama 明细块')
assert.equal(cellValue(card, '月度总额'), '$100')
assert.equal(cellValue(card, '已用'), '$25')
assert.equal(cellValue(card, '剩余'), '$75')
assert.equal(cellValue(card, '购买余额'), '$5')
assert.match(cellValue(card, '重置日期'), /2026/, '重置日期来自 windows.monthly.resetsAt')
const fallbackReset = renderPlan({ state: { ...fullState, codingPlans: { 'ollama-cloud': { ...live, windows: {} } } } })
assert.match(cellValue(fallbackReset, '重置日期'), /2026/, '缺少 monthly 窗口时用 included.periodUntil')
assert.match(text(fallbackReset), /月度总额/, '没有窗口百分比时明细仍可见')

assert.equal(cellValue(card, '近 24h'), '$1.25')
assert.match(cellSub(card, '近 24h'), /1\.2K/)
assert.match(cellSub(card, '近 24h'), /12/)
assert.equal(cellValue(card, '近 7d'), '$0', '费用 0 照常显示,不能变成 —')
assert.match(cellSub(card, '近 7d'), /0/)
assert.equal(cellValue(card, '近 30d'), '—', '缺失费用显示 —')
assert.match(text(card), /不是 DSH 会话实际扣款/)
assert.equal(text(card).includes('今日'), false, '不把 24h 称为今日')

// 币种走现有 formatMoneyUsd:CNY 配置下同一 USD 数值按 exchangeRate 显示。
const cnyConfig = ui.parseConfig(sanitizeConfig({ ...base, currency: 'CNY', symbol: '¥', exchangeRate: 7 }), 'config')
const cnyCard = renderPlan({ state: { ...fullState, config: cnyConfig }, draft: cnyConfig })
assert.equal(cellValue(cnyCard, '月度总额'), '¥700')
assert.equal(cellValue(cnyCard, '剩余'), '¥525')
// 英文界面走同一份内联文案。
const enConfig = ui.parseConfig(sanitizeConfig({ ...base, locale: 'en' }), 'config')
const enCard = renderPlan({ state: { ...fullState, config: enConfig }, draft: enConfig, t: ui.makeT('en') })
assert.equal(cellValue(enCard, 'Monthly allowance'), '$100')
assert.equal(cellValue(enCard, 'Last 24h'), '$1.25')
assert.match(cellSub(enCard, 'Last 24h'), /requests/)
assert.match(text(enCard), /not DSH session charges/)

// 缺失值不得回落为 0;购买余额 0 仍显示。
const sparseLive = {
  ...live,
  ollama: {
    included: { allowanceUsd: 100 },
    purchasedBalanceUsd: 0,
    usage: {
      '24h': { requestCount: 0, usageUsd: 0 },
      '7d': {},
      '30d': null,
    },
    usageUnavailable: true,
  },
}
const sparseCard = renderPlan({ state: { ...fullState, codingPlans: { 'ollama-cloud': sparseLive } } })
assert.equal(cellValue(sparseCard, '已用'), '—', '总额/剩余不齐时不推导已用')
assert.equal(cellValue(sparseCard, '剩余'), '—')
assert.equal(cellValue(sparseCard, '购买余额'), '$0')
assert.equal(cellValue(sparseCard, '近 24h'), '$0')
assert.match(cellSub(sparseCard, '近 24h'), /0 次请求/)
assert.equal(cellValue(sparseCard, '近 7d'), '—')
assert.equal(cellValue(sparseCard, '近 30d'), '—')
assert.match(text(sparseCard), /暂不提供用量区间/)

// 失败但保留上次数据:错误 + 可能过期提示 + 旧数据仍可见。
const stale = renderPlan({ state: { ...fullState, codingPlans: { 'ollama-cloud': {
  ...live, status: 'error', message: 'HTTP 503', fetchedAt,
} } } })
assert.match(text(stale), /HTTP 503/)
assert.match(text(stale), /可能已过期/)
assert.equal(cellValue(stale, '月度总额'), '$100')
assert.ok(byProp(stale, 'data-cm-ollama', 'detail'))

// 设置项:凭据目标、OLLAMA_API_KEY 提示、刷新间隔与最短缓存说明。
const opened = renderPlan({ targeted: true })
assert.match(text(opened), /OLLAMA_API_KEY/)
assert.match(text(opened), /Retry-After/)
assert.ok(nodes(opened).some(node => node.type === 'input' && node.props.type === 'number'), '刷新间隔输入框存在')
assert.ok(!nodes(opened).some(node => node.props?.type === 'password'), '凭据输入框默认不挂载,避免自动填充串号')
assert.ok(!nodes(opened).some(node => node.props?.['data-query-account']), 'Ollama 不显示多账号编辑器')

// 单账号来源:ollama-cloud 不在 QUERY_ACCOUNT_SOURCES,不能经 AccountCredentialField
// 追加 @default(宿主 queryAccountTarget 会拒绝);直接用 CredentialField 保存原始 target。
const credentialTargets = []
const credentialMounts = []
const savedCredentials = []
const credentialApi = {
  setCredential: async (target, value) => { savedCredentials.push({ target, value }); return { message: 'ok' } },
  clearCredential: async () => ({ message: 'ok' }),
}
const spyUi = { ...ui, CredentialField: props => {
  credentialTargets.push(props.target)
  // 保留真实 CredentialField 的 hook 槽位,便于在卡片内点击编辑/保存;
  // 记录的是卡片实际传入的 target(若回归成 AccountCredentialField 会带 @default)。
  const owner = { hooks: [], cursor: 0 }
  const render = () => {
    const previous = active
    active = owner
    owner.cursor = 0
    let tree
    try { tree = ui.CredentialField(props) } finally { active = previous }
    return expand(tree)
  }
  const instance = { render }
  credentialMounts.push(instance)
  return instance.render()
} }
const spyPlanPage = plansFactory(name => name === 'react' ? React : {}).mount(spyUi)
expand(spyPlanPage({ planId: 'ollama-cloud', labelKey: 'codingPlanOllama', state: fullState, api: credentialApi, t,
  draft: config, setDraft: () => {}, targeted: true }))
assert.deepEqual(credentialTargets, ['codingPlans.ollama-cloud'], 'Ollama 凭据 target 不追加 @default')

const credential = credentialMounts[0]
let credentialTree = credential.render()
const editButton = nodes(credentialTree).find(node => node.type === 'button' && text(node) === t('credentialEdit'))
assert.ok(editButton, '凭据编辑按钮存在')
editButton.props.onClick()
credentialTree = credential.render()
const passwordInput = nodes(credentialTree).find(node => node.type === 'input' && node.props.type === 'password')
assert.ok(passwordInput, '点击编辑后出现密码输入框')
passwordInput.props.onChange({ target: { value: 'sk-ollama-test' } })
credentialTree = credential.render()
nodes(credentialTree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
for (let i = 0; i < 6; i++) await Promise.resolve()
assert.deepEqual(savedCredentials, [{ target: 'codingPlans.ollama-cloud', value: 'sk-ollama-test' }], '保存使用原始 target')
// 首版默认刷新 5 分钟(手动刷新由宿主最短 1 分钟节流,见上一段文案)。
const noRefreshDraft = { ...config, codingPlans: { ...config.codingPlans, 'ollama-cloud': { enabled: true, display: 'settings' } } }
const noRefresh = renderPlan({ draft: noRefreshDraft, targeted: true })
const refreshInput = nodes(noRefresh).find(node => node.type === 'input' && node.props.type === 'number')
assert.equal(refreshInput.props.value, '5', '未配置时默认刷新间隔为 5 分钟')
let savedDraft
const capture = renderPlan({ draft: noRefreshDraft, setDraft: value => { savedDraft = value } })
const enableBox = nodes(capture).find(node => node.type === 'input' && node.props.type === 'checkbox')
enableBox.props.onChange({ target: { checked: true } })
assert.equal(savedDraft.codingPlans['ollama-cloud'].refreshMinutes, 5, '开启时写入 5 分钟默认值,避免下次回读变 15')

// ── 4. 侧边栏:复用通用 Coding Plan 卡片与显示位置设置 ─────────────────────
const sidebarConfig = ui.parseConfig(sanitizeConfig({
  ...base, codingPlans: { 'ollama-cloud': { enabled: true, display: 'sidebar', refreshMinutes: 30 } },
}), 'config')
const sidebarState = { ...fullState, config: sidebarConfig }
const footer = expand(ui.renderSidebarFooter(sidebarState, true))
const sidebarCard = byProp(footer, 'data-cm-plan', 'ollama-cloud')
assert.ok(sidebarCard, '侧边栏出现 ollama-cloud 卡片')
assert.match(text(sidebarCard), /25%/, '月度已用百分比来自 windows.monthly')
assert.match(text(sidebarCard), /Ollama/)
const placeholderState = { ...sidebarState, codingPlans: { 'ollama-cloud': { ...live, status: 'off', windows: {}, ollama: undefined } } }
assert.match(text(expand(ui.renderSidebarFooter(placeholderState, true))), /未查询额度/, '无数据时保留占位与重试入口')

// ── 5. 输入框上方横条:同一 display 设置派生 composer chip ─────────────────
const stripConfig = ui.parseConfig(sanitizeConfig({
  ...base, quotaStrip: { enabled: true, plans: true },
  codingPlans: { 'ollama-cloud': { enabled: true, display: 'both', refreshMinutes: 30 } },
}), 'config')
const strip = expand(el(ui.QuotaStrip, { useCost: () => ({ state: { ...fullState, config: stripConfig } }), api: {} }))
const chip = nodes(strip).find(node => typeof node.props?.className === 'string' && node.props.className.startsWith('cm-qchip'))
assert.ok(chip, '输入区出现 ollama-cloud chip')
assert.match(text(chip), /ollama/i)
assert.match(text(chip), /25%/)

console.log('[ok] ollama-cloud client: vendor row, zh/en, .ollama pass-through, detail figures, zero/missing, stale warning, settings, sidebar and composer')
