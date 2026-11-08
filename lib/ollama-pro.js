/**
 * Ollama 云端 Pro 官方额度(新版 balance / usage)。
 *
 * 协议:https://docs.ollama.com/api/balance.md 与 https://docs.ollama.com/api/cloud-usage.md。
 * 两个端点都只读、固定 https://ollama.com、Bearer OLLAMA_API_KEY。这里刻意不接受调用方
 * 传入 URL:凭据只能发往硬编码的官方域名;redirect 一律 manual,避免 30x 把 Authorization
 * 头带到未知主机。
 *
 * 只做展示快照:外部账户的 usage 与本地账本口径不同(套餐覆盖、延迟入账、团队共享),
 * 写进会话账本会与本地计费重复,因此本模块不导入 store/ledger,也不返回任何可入账字段。
 *
 * legacy 套餐(session/weekly 剩余百分比)的响应结构与新版完全不同,明确不支持:
 * 解析层返回 null,查询层抛 ollamaLegacyUnsupported,不做旧版兼容映射。
 */
import { fetchWithRetry, readJsonBounded } from './net.js'

export const OLLAMA_BALANCE_URL = 'https://ollama.com/api/balance'
export const OLLAMA_USAGE_URL = 'https://ollama.com/api/usage'

/** usage 端点的 range 枚举。 */
const USAGE_RANGES = ['24h', '7d', '30d']
/** balance 约 200B,usage 含 buckets/groups 也只在数十 KB 量级;超出即视为异常响应。 */
const MAX_BYTES = 131072
const REQUEST_TIMEOUT_MS = 15000
const MAX_KEY_LENGTH = 512
/**
 * Retry-After 的溢出饱和点,只保证毫秒数可表示,不做业务上限截断。
 * 官方可以合法要求等待任意久(小时、天),把它缩短成更早的重试等于违背服务端指令,
 * 所以只有超出 Number 安全整数(约 2.85 亿年)的溢出值才饱和到这里——方向永远更晚。
 */
const MAX_RETRY_AFTER_MS = Number.MAX_SAFE_INTEGER
/** 提示文案用秒数展示的上限;更长的等待只说「稍后重试」,不把 30 天渲染成 2592000 秒。 */
const RETRY_HINT_LIMIT_MS = 3600000

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 字段缺失哨兵:缺失与「值为 0」必须区分,缺字段绝不当零。
 * (readNumber 返回 MISSING = 缺失、null = 存在但无效、number = 有效值。)
 */
const MISSING = Symbol('missing')

const readNumber = (container, field, { integer = false } = {}) => {
  const raw = container[field]
  if (raw === undefined || raw === null) return MISSING
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null
  if (integer && !Number.isInteger(raw)) return null
  return raw
}

/**
 * 严格 ISO-8601 时刻:必须带时区(Z 或 ±HH:MM)且能往返为有效 Date。
 * 裸日期(2026-09-15)、自然语言、数字时间戳一律拒绝;Date.parse 会把 2 月 30 日
 * 自动进位到 3 月 2 日,所以日期/时间分量单独做日历校验,避免静默偏一天。
 */
const ISO_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/
const MAX_DATE_MS = 8640000000000000
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const isLeapYear = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
const isoInstant = value => {
  if (typeof value !== 'string') return null
  const match = ISO_INSTANT_RE.exec(value.trim())
  if (match === null) return null
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  const monthDays = MONTH_DAYS[monthNumber - 1]
  if (monthDays === undefined) return null
  if (dayNumber < 1 || dayNumber > (monthNumber === 2 && isLeapYear(Number(year)) ? 29 : monthDays)) return null
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return null
  const ms = Date.parse(match[0])
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null
  return new Date(ms).toISOString()
}

/**
 * 是否为旧版套餐响应(session/weekly 剩余百分比)。
 * 新版字段优先:同一响应同时带 balance_usd/allowance_usd/period 时按新版解析。
 * @param {unknown} data - balance 响应体。
 * @returns {boolean}
 */
export function isLegacyOllamaBalance(data) {
  const included = record(data) ? data.included : null
  if (!record(included)) return false
  if (Object.hasOwn(included, 'balance_usd') || Object.hasOwn(included, 'allowance_usd') || record(included.period)) return false
  return Object.hasOwn(included, 'session') || Object.hasOwn(included, 'weekly')
}

/**
 * 解析新版 balance 响应(纯函数,不发请求)。
 * @param {unknown} data - GET https://ollama.com/api/balance 的 JSON。
 * @returns {{included: {balanceUsd: number, allowanceUsd: number, periodFrom: string, periodUntil: string}, purchasedBalanceUsd: number} | null}
 *   结构无效或为 legacy 套餐时返回 null(不编造零余额)。
 */
export function parseOllamaBalance(data) {
  if (!record(data) || isLegacyOllamaBalance(data)) return null
  const included = data.included
  if (!record(included)) return null
  const balanceUsd = readNumber(included, 'balance_usd')
  const allowanceUsd = readNumber(included, 'allowance_usd')
  if (balanceUsd === MISSING || balanceUsd === null) return null
  if (allowanceUsd === MISSING || allowanceUsd === null) return null
  if (!record(included.period)) return null
  const periodFrom = isoInstant(included.period.from)
  const periodUntil = isoInstant(included.period.until)
  // from 含、until 不含;倒置或零长周期说明响应不可信。
  if (periodFrom === null || periodUntil === null || Date.parse(periodFrom) >= Date.parse(periodUntil)) return null
  const purchased = data.purchased
  if (!record(purchased)) return null
  const purchasedBalanceUsd = readNumber(purchased, 'balance_usd')
  if (purchasedBalanceUsd === MISSING || purchasedBalanceUsd === null) return null
  return { included: { balanceUsd, allowanceUsd, periodFrom, periodUntil }, purchasedBalanceUsd }
}

/**
 * 解析 usage 响应中的 totals(纯函数)。buckets 不参与展示,故不读取。
 * @param {unknown} data - GET https://ollama.com/api/usage?range=... 的 JSON。
 * @param {'24h'|'7d'|'30d'} range - 请求的时间窗;响应若自报 range 且不一致则拒绝。
 * @returns {{from: string, until: string, requestCount: number, usageUsd?: number, inputTokens?: number, cachedInputTokens?: number, outputTokens?: number} | null}
 *   可选指标缺失(或显式 null)时对应键不出现,绝不填 0;存在但非法(字符串/NaN/负数/小数计数)则整体判定无效返回 null。
 */
export function parseOllamaUsage(data, range) {
  if (!record(data)) return null
  if (!USAGE_RANGES.includes(range)) return null
  // range 是窗口标签:自报值与请求值不同,说明拿到的不是这个窗口的数据。
  // 字段整体缺失时不据此拒绝(缺少标签不使数值失真),但一旦出现必须一致。
  if (data.range !== undefined && data.range !== null && data.range !== range) return null
  const from = isoInstant(data.from)
  const until = isoInstant(data.until)
  if (from === null || until === null || Date.parse(from) > Date.parse(until)) return null
  const totals = data.totals
  if (!record(totals)) return null
  const requestCount = readNumber(totals, 'request_count', { integer: true })
  if (requestCount === MISSING || requestCount === null) return null
  const parsed = { from, until, requestCount }
  const metrics = [
    ['usage_usd', 'usageUsd', false],
    ['input_tokens', 'inputTokens', true],
    ['cached_input_tokens', 'cachedInputTokens', true],
    ['output_tokens', 'outputTokens', true],
  ]
  for (const [field, key, integer] of metrics) {
    const value = readNumber(totals, field, { integer })
    if (value === null) return null
    if (value !== MISSING) parsed[key] = value
  }
  return parsed
}

// ── 文案(zh/en;宿主 t 未注册本模块 code 时回落到这里) ─────────────────────

const MESSAGES = {
  zh: {
    ollamaKeyMissing: '未配置 Ollama 云端 API Key，无法查询 Pro 额度。',
    ollamaKeyInvalid: 'Ollama API Key 格式无效：请粘贴 Key 本身，不要包含空格、换行或其他文字。',
    ollamaNetwork: 'Ollama 额度查询网络请求失败，请稍后重试。',
    ollamaRedirect: 'Ollama 额度接口返回重定向，已拒绝继续携带凭据请求。',
    ollamaUnauthorized: 'Ollama 凭据无效、已过期或账户被暂停（HTTP {status}），请更新 API Key 后重试。',
    ollamaRateLimited: 'Ollama 额度接口请求过于频繁（HTTP 429）。',
    ollamaServiceUnavailable: 'Ollama 额度接口暂时不可用（HTTP 503），请稍后重试。',
    ollamaHttp: 'Ollama 额度接口返回 HTTP {status}。',
    ollamaBadPayload: 'Ollama 额度响应无法读取为有效 JSON 或体积超限。',
    ollamaInvalidShape: 'Ollama 额度响应缺少有效字段，未将其视为零余额。',
    ollamaLegacyUnsupported: '当前 Ollama 账户仍是旧版套餐（session/weekly 限额），本插件只支持新版 Pro 余额与用量接口。',
    ollamaUsagePartial: 'Ollama 用量部分窗口暂不可用：{details}；余额数据已保留。',
    ollamaUsageUnavailable: 'Ollama 用量暂不可用：{details}；余额数据已保留。',
    ollamaUsageRetryHint: '请在约 {seconds} 秒后重试。',
    ollamaUsageRetryLater: '请稍后重试。',
    ollamaReasonNetwork: '网络请求失败',
    ollamaReasonRedirect: '重定向已拒绝',
    ollamaReasonAuth: '凭据无效',
    ollamaReasonRateLimited: '请求过于频繁',
    ollamaReasonUnavailable: '服务暂时不可用',
    ollamaReasonHttp: 'HTTP {status}',
    ollamaReasonPayload: '响应无法解析',
  },
  en: {
    ollamaKeyMissing: 'No Ollama Cloud API key configured, so the Pro quota cannot be queried.',
    ollamaKeyInvalid: 'Invalid Ollama API key format: paste the key itself without spaces, line breaks or extra text.',
    ollamaNetwork: 'The Ollama quota request failed on the network; retry later.',
    ollamaRedirect: 'The Ollama quota endpoint returned a redirect; the credential was not forwarded.',
    ollamaUnauthorized: 'The Ollama credential is invalid, expired or the account is suspended (HTTP {status}); update the API key and retry.',
    ollamaRateLimited: 'The Ollama quota endpoint is rate limited (HTTP 429).',
    ollamaServiceUnavailable: 'The Ollama quota endpoint is temporarily unavailable (HTTP 503); retry later.',
    ollamaHttp: 'The Ollama quota endpoint returned HTTP {status}.',
    ollamaBadPayload: 'The Ollama quota response is not valid JSON or exceeds the size limit.',
    ollamaInvalidShape: 'The Ollama quota response has no valid fields; it was not treated as a zero balance.',
    ollamaLegacyUnsupported: 'This Ollama account still uses a legacy plan (session/weekly limits); only the new Pro balance and usage endpoints are supported.',
    ollamaUsagePartial: 'Some Ollama usage windows are unavailable: {details}; the balance is still shown.',
    ollamaUsageUnavailable: 'Ollama usage is unavailable: {details}; the balance is still shown.',
    ollamaUsageRetryHint: 'Retry in about {seconds} s.',
    ollamaUsageRetryLater: 'Retry later.',
    ollamaReasonNetwork: 'network request failed',
    ollamaReasonRedirect: 'redirect refused',
    ollamaReasonAuth: 'invalid credential',
    ollamaReasonRateLimited: 'rate limited',
    ollamaReasonUnavailable: 'temporarily unavailable',
    ollamaReasonHttp: 'HTTP {status}',
    ollamaReasonPayload: 'response could not be parsed',
  },
}

/**
 * 取文案:宿主 t 认识该 code 时用宿主文案(便于统一 UI 用语),否则用本模块自带双语。
 * 宿主的 tmsg 对未知 code 原样返回 code,因此「返回值等于 code」即视为未注册。
 */
const translate = (locale, t, code, vars) => {
  let external
  if (typeof t === 'function') {
    try { external = t(locale, code, vars) } catch { external = undefined }
  }
  if (typeof external === 'string' && external !== '' && external !== code) return external
  const dict = MESSAGES[locale === 'en' ? 'en' : 'zh']
  const template = dict[code] ?? MESSAGES.zh[code] ?? code
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}

/** 释放未消费的响应体,避免错误路径占住连接池。 */
const discardBody = async response => { try { await response?.body?.cancel?.() } catch { /* 清理失败不掩盖原始错误。 */ } }

/** delay-seconds 形态(RFC 9110 为非负整数;兼容小数,避免把 1.5 丢给 Date.parse)。 */
const DELAY_SECONDS_RE = /^\d+(?:\.\d+)?$/
/**
 * 解析 Retry-After(秒数或 HTTP 日期),返回毫秒。
 * 缺失或无法识别返回 0(未知,父级按自己的间隔退避);合法值原样返回,绝不提前截断。
 */
const retryAfterOf = (response, now = Date.now()) => {
  const raw = String(response?.headers?.get?.('retry-after') ?? '').trim()
  if (raw === '') return 0
  if (DELAY_SECONDS_RE.test(raw)) {
    const ms = Number(raw) * 1000
    return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.round(ms)) : MAX_RETRY_AFTER_MS
  }
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, at - now))
}

/**
 * 查询 Ollama 云端 Pro 额度:balance 必须成功,24h/7d/30d 三个 usage 并行且允许部分降级。
 *
 * 不自己缓存、不 sleep 重试:429 只把 Retry-After 解析成 retryAfterMs 交给父级调度。
 * 父级缓存应尊重该值,而不是在这里阻塞。
 *
 * @param {unknown} key - OLLAMA_API_KEY(仅进 Authorization 头,不进任何错误文案)。
 * @param {'zh'|'en'|string} locale - 文案语言,非 en 一律 zh。
 * @param {(locale: string, code: string, vars?: Record<string, string|number>) => string} [t] - 宿主文案函数。
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{
 *   windows: {monthly: {percent?: number, resetsAt: string}},
 *   ollama: {included: {balanceUsd: number, allowanceUsd: number, periodFrom: string, periodUntil: string}, purchasedBalanceUsd: number, usage: Record<string, object>, usageUnavailable?: boolean},
 *   endpoint: string, message?: string, retryAfterMs?: number
 * }>}
 *   windows.monthly.percent 是已用百分比 0..100(总额为 0 时无比例可言,不给出);
 *   usage 只包含成功解析的窗口,失败窗口的键不出现(缺失≠0);retryAfterMs 仅在出现 429 时给出。
 */
export async function queryOllamaPro(key, locale, t, { signal } = {}) {
  const lang = locale === 'en' ? 'en' : 'zh'
  const say = (code, vars) => translate(lang, t, code, vars)
  const failure = (code, vars, extra) => Object.assign(new Error(say(code, vars)), { code, ...extra })
  const tagged = (kind, extra) => Object.assign(new Error(kind), { ollamaKind: kind, ...extra })

  if (typeof key !== 'string' || key.trim() === '') throw failure('ollamaKeyMissing', undefined, { soft: true })
  const token = key.trim()
  // Key 只经 Authorization 头发送:空白/控制字符既非法,也可能被用来注入请求头。
  if (token.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(token)) throw failure('ollamaKeyInvalid', undefined, { soft: true })
  signal?.throwIfAborted()

  /** 固定 URL、固定头、固定 manual redirect;返回已解析 JSON 或带 ollamaKind 的内部错误。 */
  const requestJson = async url => {
    let response
    try {
      response = await fetchWithRetry(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'accept-encoding': 'identity' },
        redirect: 'manual',
        signal,
      }, { timeoutMs: REQUEST_TIMEOUT_MS, attempts: 2 })
    } catch {
      signal?.throwIfAborted()
      throw tagged('network')
    }
    // 浏览器对 manual redirect 可能给出 status 0 的不透明响应;与 30x 同等对待。
    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      await discardBody(response)
      throw tagged('redirect', { status: response.status })
    }
    if (!response.ok) {
      const retryAfterMs = retryAfterOf(response)
      await discardBody(response)
      if (response.status === 401 || response.status === 403) throw tagged('auth', { status: response.status })
      if (response.status === 429) throw tagged('rate', { status: 429, retryAfterMs })
      if (response.status === 503) throw tagged('unavailable', { status: 503 })
      throw tagged('http', { status: response.status })
    }
    try {
      return await readJsonBounded(response, MAX_BYTES, { signal })
    } catch (error) {
      signal?.throwIfAborted()
      await discardBody(response)
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw tagged('network')
      throw tagged(error?.code === 'RESPONSE_TOO_LARGE' ? 'tooLarge' : 'payload')
    }
  }

  const describe = error => {
    const status = error?.status
    if (error?.ollamaKind === 'auth') return failure('ollamaUnauthorized', { status }, { soft: true, status })
    if (error?.ollamaKind === 'rate') return failure('ollamaRateLimited', undefined, { status: 429, retryAfterMs: error.retryAfterMs })
    if (error?.ollamaKind === 'unavailable') return failure('ollamaServiceUnavailable', undefined, { status: 503 })
    if (error?.ollamaKind === 'http') return failure('ollamaHttp', { status }, { status })
    if (error?.ollamaKind === 'redirect') return failure('ollamaRedirect', undefined, { status })
    if (error?.ollamaKind === 'network') return failure('ollamaNetwork')
    return failure('ollamaBadPayload')
  }

  // 额度必须成功:拿不到 balance 就没有可展示的兜底数据。
  let payload
  try { payload = await requestJson(OLLAMA_BALANCE_URL) } catch (error) { throw error?.ollamaKind ? describe(error) : error }
  if (isLegacyOllamaBalance(payload)) throw failure('ollamaLegacyUnsupported', undefined, { soft: true })
  const balance = parseOllamaBalance(payload)
  if (balance === null) throw failure('ollamaInvalidShape')

  const results = await Promise.all(USAGE_RANGES.map(async range => {
    try {
      const parsed = parseOllamaUsage(await requestJson(`${OLLAMA_USAGE_URL}?range=${range}`), range)
      return parsed === null ? { range, error: { ollamaKind: 'payload' } } : { range, parsed }
    } catch (error) {
      // 取消/中止原样冒泡;只有单个窗口的接口失败才降级。
      if (!error?.ollamaKind) throw error
      return { range, error }
    }
  }))

  const usage = {}
  const failures = []
  let rateLimited = false
  let retryAfterMs = 0
  for (const entry of results) {
    if (entry.parsed) { usage[entry.range] = entry.parsed; continue }
    failures.push(entry)
    if (entry.error.ollamaKind === 'rate') {
      rateLimited = true
      retryAfterMs = Math.max(retryAfterMs, entry.error.retryAfterMs || 0)
    }
  }

  let message
  if (failures.length > 0) {
    const details = failures.map(({ range, error }) => {
      const reason = error.ollamaKind === 'network' ? say('ollamaReasonNetwork')
        : error.ollamaKind === 'redirect' ? say('ollamaReasonRedirect')
          : error.ollamaKind === 'auth' ? say('ollamaReasonAuth')
            : error.ollamaKind === 'rate' ? say('ollamaReasonRateLimited')
              : error.ollamaKind === 'unavailable' ? say('ollamaReasonUnavailable')
                : error.ollamaKind === 'http' ? say('ollamaReasonHttp', { status: error.status })
                  : say('ollamaReasonPayload')
      return lang === 'en' ? `${range} (${reason})` : `${range}（${reason}）`
    }).join(lang === 'en' ? ', ' : '、')
    message = say(failures.length === USAGE_RANGES.length ? 'ollamaUsageUnavailable' : 'ollamaUsagePartial', { details })
    // 没有 Retry-After 时(值为 0)不猜秒数,交给父级按自己的间隔退避;超过一小时
    // 只说「稍后」,避免把合法的大值渲染成几十万秒。
    if (rateLimited && retryAfterMs > 0) {
      message += ` ${retryAfterMs <= RETRY_HINT_LIMIT_MS
        ? say('ollamaUsageRetryHint', { seconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) })
        : say('ollamaUsageRetryLater')}`
    }
  }

  const { allowanceUsd, balanceUsd, periodUntil } = balance.included
  // 已用 = 1 - 剩余/总额;总额为 0 时没有比例可言,不编造 0% 或 100%。保留两位小数只是
  // 去掉浮点尾数,原始金额仍完整保留在 ollama.included 里。
  const percent = allowanceUsd > 0 ? Math.min(100, Math.max(0, Math.round((1 - balanceUsd / allowanceUsd) * 10000) / 100)) : undefined
  const monthly = percent === undefined ? { resetsAt: periodUntil } : { percent, resetsAt: periodUntil }

  const result = {
    windows: { monthly },
    ollama: { included: balance.included, purchasedBalanceUsd: balance.purchasedBalanceUsd, usage },
    endpoint: OLLAMA_BALANCE_URL,
  }
  if (failures.length === USAGE_RANGES.length) result.ollama.usageUnavailable = true
  if (message !== undefined) result.message = message
  if (rateLimited) result.retryAfterMs = retryAfterMs
  return result
}
