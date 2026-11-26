'use strict'

// koishi-plugin-weidian-monitor
// 参考 CoolQ 插件 me.cqp.lyt.modianMonitor（应援 3.65）的功能重写。
// 原插件依赖私有鉴权服务器与收费版本门槛，本插件完全本地运行、无第三方鉴权。

const fs = require('node:fs/promises')
const path = require('node:path')
const { Schema, h } = require('koishi')

const PLATFORMS = ['weidian', 'modian', 'owhat', 'taoba']

const PLATFORM_LINK = {
  weidian: (id) => `https://weidian.com/item.html?itemID=${id}`,
  modian: (id) => `https://zhongchou.modian.com/item/${id}`,
  owhat: (id) => `https://m.owhat.cn/shop/shopdetail.html?id=${id}`,
  taoba: (id) => `https://www.taoba.club/#/pages/idols/detail?id=${id}`,
}

const DEFAULT_TEMPLATE = '【{project}】新集资 +{diff} 元，当前 {amount} 元，{supporters} 人参与\n{link}'
const DEFAULT_DELIVERY_TEMPLATE = '【自动发货】订单 {orderId} 已发货（{mode}）\n商品：{items}\n金额：{amount} 元\n卡密：{codes}'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

// 微店商家后台接口（从 d.weidian.com 前端资源提取）
const WD_ORDER_LIST_API = 'https://thor.weidian.com/tradeview/seller.getOrderListForPC/1.0'
const WD_ORDER_DELIVER_API = 'https://thor.weidian.com/tradeview/seller.deliverOrder/1.0'
const WD_SUB_ACCOUNT_LOGIN_URL = 'https://d.weidian.com/weidian-pc/login/#/subAccount'

/* ---------------------------------- 工具 ---------------------------------- */

function walk(object, visitor, depth = 0) {
  if (!object || typeof object !== 'object' || depth > 10) return false
  for (const [key, value] of Object.entries(object)) {
    if (visitor(key, value)) return true
    if (value && typeof value === 'object' && walk(value, visitor, depth + 1)) return true
  }
  return false
}

function findNumber(object, keys) {
  let result
  walk(object, (key, value) => {
    if (!keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) return false
    if (typeof value === 'number' && Number.isFinite(value)) {
      result = value
      return true
    }
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
      result = Number(value)
      return true
    }
    return false
  })
  return result
}

function findString(object, keys) {
  let result
  walk(object, (key, value) => {
    if (!keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) return false
    if (typeof value === 'string' && value.trim()) {
      result = value.trim()
      return true
    }
    return false
  })
  return result
}

// ctx.http.get 对 JSON 响应会直接返回对象，对 JSONP / HTML 则返回字符串。
function parseLooseJson(payload) {
  if (payload && typeof payload === 'object') return payload
  const text = String(payload ?? '')
  const firstBrace = text.indexOf('{')
  const firstBracket = text.indexOf('[')
  let start = firstBrace
  if (firstBracket >= 0 && (firstBrace < 0 || firstBracket < firstBrace)) start = firstBracket
  if (start < 0) throw new Error('响应中未找到 JSON 数据')
  const closing = text[start] === '{' ? '}' : ']'
  const end = text.lastIndexOf(closing)
  if (end <= start) throw new Error('响应中的 JSON 数据不完整')
  return JSON.parse(text.slice(start, end + 1))
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function money(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function parseChannel(channel) {
  if (channel.includes(':')) {
    const index = channel.indexOf(':')
    return { platform: channel.slice(0, index), id: channel.slice(index + 1) }
  }
  return { platform: '', id: channel }
}

/* ------------------------------- 数据抓取 -------------------------------- */

function buildUrl(project) {
  if (project.api) return project.api
  switch (project.platform) {
    case 'modian':
      return `https://zhongchou.modian.com/realtime/get_simple_product?ids=${encodeURIComponent(project.id)}`
    case 'owhat': {
      const data = JSON.stringify({ fk_goods_id: project.id })
      return `https://appo4.owhat.cn/api?client_id=3&cmd_m=findPricesAndStock&cmd_s=shop.price&v=1.6.1L&data=${encodeURIComponent(data)}`
    }
    case 'taoba':
      return `https://www.taoba.club/idols/detail?id=${encodeURIComponent(project.id)}`
    case 'weidian':
    default: {
      const data = JSON.stringify({ itemId: project.id })
      return `https://thor.weidian.com/detail/getItemSkuInfo/1.0?param=${encodeURIComponent(data)}`
    }
  }
}

function extractSnapshot(project, payload) {
  let amount
  let supporters
  let name

  // 微店：SKU 列表中的 sold * discountPrice
  const skus = payload?.result?.skuInfos || payload?.skuInfos
  if (Array.isArray(skus) && skus.length) {
    amount = 0
    supporters = 0
    for (const entry of skus) {
      const sku = entry?.skuInfo || entry
      const sold = toNumber(sku?.sold ?? sku?.sales ?? sku?.itemStock)
      const price = toNumber(sku?.discountPrice ?? sku?.price ?? sku?.itemDiscountHighPrice)
      amount += sold * price
      supporters += sold
    }
    name = findString(payload, ['title', 'name', 'itemName', 'skuTitle'])
  }

  // OWHAT：data.prices 中的 pricestr（单价）与 salestock（销量）
  const prices = payload?.data?.prices
  if (amount === undefined && Array.isArray(prices) && prices.length) {
    amount = 0
    supporters = 0
    for (const item of prices) {
      const price = toNumber(item?.pricestr ?? item?.price ?? item?.discountPrice)
      const sold = toNumber(item?.salestock ?? item?.sold ?? item?.sales)
      amount += price * sold
      supporters += sold
    }
    name = findString(payload, ['title', 'name', 'goodsName'])
  }

  // 摩点 / 桃叭 / 自定义接口：按常见字段名猜测
  if (amount === undefined) {
    amount = findNumber(payload, [
      'backer_money', 'backerMoney', 'total_amount', 'totalAmount',
      'donation', 'amount', 'money', 'sum',
    ])
  }
  if (supporters === undefined) {
    supporters = findNumber(payload, [
      'backer_count', 'backerCount', 'supporter_count', 'supporterCount',
      'backers', 'people', 'joinusers', 'count',
    ])
  }
  if (!name) name = findString(payload, ['name', 'title', 'projectName', 'itemName'])

  if (amount === undefined || !Number.isFinite(amount)) {
    throw new Error('未能从接口响应中解析出金额，请检查项目 ID 或配置自定义 api')
  }

  return {
    amount: Math.round(amount * 100) / 100,
    supporters: Math.max(0, Math.round(supporters ?? 0)),
    name: name || project.name || project.id,
    link: (PLATFORM_LINK[project.platform] || PLATFORM_LINK.weidian)(project.id),
    updatedAt: Date.now(),
  }
}

async function request(ctx, url, headers, timeout) {
  // 优先使用 Koishi 的 http 服务（可统一配置代理/超时）；裸 Context 下回退到 Node 内置 fetch。
  if (ctx.http && typeof ctx.http.get === 'function') {
    return ctx.http.get(url, { headers, timeout: timeout * 1000 })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout * 1000)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  } finally {
    clearTimeout(timer)
  }
}

// 微店后台接口的 status 字段在不同接口里可能是 code / status_code / statusCode
function apiCode(payload) {
  const status = payload?.status || payload?.result?.status || {}
  const value = status.code ?? status.status_code ?? status.statusCode ?? status.status
  return Number(value)
}

function apiMessage(payload) {
  const status = payload?.status || payload?.result?.status || {}
  return String(status.message || status.description || status.status_reason || status.reason || '未知错误')
}

function orderAmount(order) {
  const candidates = [
    order?.total, order?.payFee, order?.paidAmount, order?.amount,
    order?.normalPriceInfo?.totalPrice, order?.priceInfo?.totalPrice,
  ]
  for (const value of candidates) {
    const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

function orderItems(order) {
  const items = order?.itemList || order?.items || []
  return Array.isArray(items) ? items : []
}

function isPaidOrder(order) {
  const status = order?.status
  const paid = status === 20 || status === '20' || status === 'paid' || status === 'PAID'
    || /待发货/.test(String(order?.statusText || order?.statusName || ''))
  if (!paid) return false
  const refund = order?.refund_status ?? order?.refundStatus ?? order?.refundStatusList
  if (refund === 1 || refund === 2 || refund === '1' || refund === '2') return false
  if (order?.flagInfo && order.flagInfo.canBatchOperate === false) return false
  if (Number(order?.cityExpressStatus) === 20) return false
  // 拼团未成团时发货会钱货两空，稳妥起见跳过
  if (Number(order?.group_status) > 0 && Number(order?.group_status) !== 1) return false
  return true
}

function matchesDeliveryFilter(order, delivery) {
  const items = orderItems(order)
  const ids = delivery.itemIds || []
  const skus = delivery.skuIds || []
  const titles = delivery.itemTitles || []
  if (!ids.length && !skus.length && !titles.length) return true
  return items.some((item) => {
    const itemId = String(item?.itemId ?? item?.item_id ?? item?.curShopItemId ?? '')
    const skuId = String(item?.skuId ?? item?.itemSkuId ?? item?.sku_id ?? item?.curShopSkuId ?? '')
    const title = String(item?.title ?? item?.itemTitle ?? item?.name ?? '')
    if (ids.length && !ids.includes(itemId)) return false
    if (skus.length && !skus.includes(skuId)) return false
    if (titles.length && !titles.some((word) => title.includes(word))) return false
    return true
  })
}

function orderItemText(order) {
  return orderItems(order).map((item) => {
    const title = item?.title || item?.itemTitle || item?.name || '商品'
    const quantity = Number(item?.quantity ?? item?.num ?? 1)
    return quantity > 1 ? `${title} ×${quantity}` : title
  }).join('、') || '订单商品'
}

async function fetchSnapshot(ctx, project, timeout, loginCookie) {
  const url = buildUrl(project)
  const headers = { 'User-Agent': UA, Accept: '*/*' }
  // 项目自己的 cookie 优先级最高，其次是扫码登录保存的全局 cookie。
  const cookie = project.cookie || (project.platform === 'weidian' ? loginCookie : '')
  if (cookie) headers.Cookie = cookie
  const response = await request(ctx, url, headers, timeout)
  return extractSnapshot(project, parseLooseJson(response))
}

/* --------------------------------- 插件主体 -------------------------------- */

const Config = Schema.object({
  projects: Schema.array(Schema.object({
    platform: Schema.union([
      Schema.const('weidian'), Schema.const('modian'),
      Schema.const('owhat'), Schema.const('taoba'),
    ]).description('众筹平台').default('weidian'),
    id: Schema.string().required().description('平台上的项目 / 商品 ID'),
    name: Schema.string().default('').description('项目备注名，便于阅读'),
    channels: Schema.array(Schema.string()).default([]).description('播报频道，格式 platform:channelId，如 onebot:123456'),
    interval: Schema.number().min(10).default(60).description('轮询间隔（秒）'),
    thanks: Schema.string().default(DEFAULT_TEMPLATE).description('播报模板，支持 {project}/{name}/{amount}/{diff}/{supporters}/{link}'),
    enabled: Schema.boolean().default(true).description('是否启用监控'),
    cookie: Schema.string().role('secret').default('').description('可选：平台登录 Cookie（桃叭等需要）'),
    api: Schema.string().default('').description('可选：自定义接口地址，留空则使用内置接口'),
  })).default([]).description('要监控的众筹项目列表'),
  admins: Schema.array(Schema.string()).default([]).description('管理员用户 ID，如 onebot:10000'),
  requestTimeout: Schema.number().min(1).max(60).default(10).description('网络请求超时（秒）'),
  noticeOnStart: Schema.boolean().default(true).description('启动后首次抓取是否播报（关闭则只记录基线）'),
  loginUrl: Schema.string().default('https://d.weidian.com/').description('微店登录页地址'),
  qrSelector: Schema.string().default('.qrcode-img, .scanQRcode canvas, canvas, .qrcode, .qr-code, [class*="qrcode"], img[src*="qrcode"], img[src*="qr"]')
    .description('二维码元素选择器，留空则发送整页截图'),
  loginTimeout: Schema.number().min(30).max(600).default(180).description('等待扫码 / 短信验证码 / 登录完成的超时（秒）'),
  cookieDomains: Schema.array(Schema.string()).default(['weidian.com']).description('提取 Cookie 时保留的域名关键字'),
  autoUseLoginCookie: Schema.boolean().default(true).description('微店项目未单独配置 cookie 时，自动使用登录得到的 Cookie'),
  phoneSelector: Schema.string().default('.user-telephone input[placeholder="手机号"], input[name="telephone"], input[placeholder="手机号"]')
    .description('手机号输入框选择器（密码 / 短信登录）'),
  passwordSelector: Schema.string().default('input[type="password"][placeholder="输入登录密码"], input[name="login-pwd"], input[type="password"]')
    .description('密码输入框选择器'),
  smsCodeSelector: Schema.string().default('input[placeholder="短信验证码"], .message-code-input input, input[name="verify-code"]')
    .description('短信验证码输入框选择器'),
  autoSlideCaptcha: Schema.boolean().default(true).description('遇到安全验证时尝试自动滑动；失败会提示改用扫码登录或手动 Cookie'),
  subAccountLoginUrl: Schema.string().default(WD_SUB_ACCOUNT_LOGIN_URL).description('微店子账号登录页地址'),
  subAccountSelector: Schema.string().default('input[placeholder="子账号登录名"], input[name="subaccountId"]')
    .description('子账号登录名输入框选择器'),
  autoDelivery: Schema.object({
    enabled: Schema.boolean().default(false).description('是否启用订单自动发货'),
    interval: Schema.number().min(10).default(30).description('轮询待发货订单的间隔（秒）'),
    cookie: Schema.string().role('secret').default('').description('发货专用 Cookie；留空则用「微店Cookie」保存的 Cookie（建议用权限全开的子账号登录）'),
    listType: Schema.number().min(0).max(3).default(0).description('订单列表类型，0=普通订单'),
    mode: Schema.union([
      Schema.const('no-logistics'), Schema.const('ecode'), Schema.const('express'),
    ]).default('no-logistics').description('发货方式：无需物流 / 电子卡券码 / 快递'),
    expressType: Schema.string().default('0').description('快递公司编号，无需物流填 0'),
    expressNo: Schema.string().default('').description('快递单号'),
    expressCustom: Schema.string().default('').description('自定义快递公司名称'),
    eCodes: Schema.array(Schema.string()).default([]).description('卡密池，ecode 模式按顺序消费，已使用的会记录到状态文件'),
    itemIds: Schema.array(Schema.string()).default([]).description('仅发货这些商品 ID，留空表示全部商品'),
    skuIds: Schema.array(Schema.string()).default([]).description('仅发货这些 SKU ID，留空表示不限'),
    itemTitles: Schema.array(Schema.string()).default([]).description('商品标题包含任一关键词才发货，留空表示不限'),
    minAmount: Schema.number().min(0).default(0).description('订单金额下限，0 表示不限'),
    channels: Schema.array(Schema.string()).default([]).description('发货结果播报频道'),
    template: Schema.string().default(DEFAULT_DELIVERY_TEMPLATE).description('发货播报模板'),
    dryRun: Schema.boolean().default(false).description('演练模式：只记录不真正发货'),
    maxPerRun: Schema.number().min(1).max(100).default(20).description('每轮最多处理的订单数'),
    retryAttempts: Schema.number().min(0).max(5).default(2).description('单笔发货失败重试次数'),
  }).default({}).description('订单自动发货配置'),
})

exports.name = 'weidian-monitor'
exports.usage = '微店 / 摩点 / OWHAT / 桃叭 众筹监控播报；支持用子账号 Cookie 自动拉取微店待发货订单并发货。管理员可通过多种方式登录并自动提取 Cookie。'
exports.Config = Config
// 浏览器服务为可选依赖：未安装 puppeteer 插件时监控照常工作，仅扫码登录不可用。
exports.inject = { optional: ['puppeteer'] }

exports.apply = (ctx, config) => {
  const logger = ctx.logger('weidian-monitor')
  const statePath = path.join(ctx.baseDir || process.cwd(), 'weidian-monitor-state.json')
  const defaultState = {
    snapshots: {}, enabled: {}, globalThanks: '', login: null,
    delivery: { enabled: null, processed: {}, usedCodes: [], lastRun: 0, lastSummary: '' },
  }
  const state = { ...defaultState, delivery: { ...defaultState.delivery } }
  const timers = []
  // 短信登录需要跨命令保留浏览器页面：userId -> { page, phone, expiresAt, timer, session }
  const pendingLogins = new Map()
  let started = false
  let loginInProgress = false
  let deliveryInProgress = false

  const isAdmin = (session) => config.admins.includes(session.userId)
  const isEnabled = (index) => state.enabled[index] ?? config.projects[index].enabled
  const projectKey = (project) => `${project.platform}:${project.id}`

  async function loadState() {
    try {
      const raw = JSON.parse(await fs.readFile(statePath, 'utf8'))
      if (raw && typeof raw === 'object') {
        state.snapshots = raw.snapshots || {}
        state.enabled = raw.enabled || {}
        state.globalThanks = raw.globalThanks || ''
        state.login = raw.login || null
        state.delivery = {
          ...defaultState.delivery,
          ...(raw.delivery || {}),
          processed: raw.delivery?.processed || {},
          usedCodes: raw.delivery?.usedCodes || [],
        }
      }
    } catch {
      // 首次运行或状态文件损坏时，从空状态开始
    }
  }

  async function saveState() {
    try {
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      logger.warn(`保存状态失败：${error.message}`)
    }
  }

  async function broadcast(channels, text) {
    let sent = 0
    for (const channel of channels) {
      const { platform, id } = parseChannel(channel)
      const bot = ctx.bots.find((item) => item.platform === platform && item.status === 'online')
        || ctx.bots.find((item) => item.platform === platform)
        || (platform ? undefined : ctx.bots[0])
      if (!bot) {
        logger.warn(`未找到可发送消息的机器人：${channel}`)
        continue
      }
      try {
        await bot.sendMessage(id, text)
        sent += 1
      } catch (error) {
        logger.warn(`发送消息到 ${channel} 失败：${error.message}`)
      }
    }
    return sent
  }

  /* ---------------------------- 订单自动发货 ---------------------------- */

  const deliveryConfig = () => config.autoDelivery || {}

  function deliveryEnabled() {
    return state.delivery.enabled ?? deliveryConfig().enabled ?? false
  }

  function deliveryCookie() {
    return deliveryConfig().cookie || state.login?.cookie || ''
  }

  async function wdApi(endpoint, param, cookie) {
    if (!cookie) throw new Error('没有可用的微店 Cookie，请先用子账号登录或「微店Cookie」设置')
    const url = `${endpoint}?param=${encodeURIComponent(JSON.stringify(param))}`
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://d.weidian.com/',
      Origin: 'https://d.weidian.com',
      Cookie: cookie,
    }
    const response = await request(ctx, url, headers, config.requestTimeout)
    const payload = parseLooseJson(response)
    if (apiCode(payload) !== 0) throw new Error(apiMessage(payload))
    return payload
  }

  async function fetchPaidOrders(cookie) {
    const delivery = deliveryConfig()
    const payload = await wdApi(WD_ORDER_LIST_API, {
      listType: delivery.listType ?? 0,
      pageNum: 0,
      pageSize: Math.min(50, Math.max(20, Number(delivery.maxPerRun) || 20)),
      statusList: ['paid'],
      refundStatusList: [],
      channel: 'pc',
      specialOrderSearchCondition: {
        notShowGroupUnsuccess: 1,
        notShowFxOrder: 0,
      },
    }, cookie)
    const orders = payload?.result?.orderList || payload?.result?.orders || []
    return Array.isArray(orders) ? orders : []
  }

  function pickCodes(count) {
    const delivery = deliveryConfig()
    const pool = (delivery.eCodes || []).map((item) => String(item).trim()).filter(Boolean)
    const used = new Set(state.delivery.usedCodes || [])
    const picked = []
    for (const code of pool) {
      if (picked.length >= count) break
      if (used.has(code)) continue
      picked.push(code)
    }
    return picked
  }

  function deliveryModeLabel(mode) {
    return { 'no-logistics': '无需物流', ecode: '电子卡券', express: '快递' }[mode] || mode
  }

  function renderDelivery(template, order, codes, mode) {
    const variables = {
      orderId: String(order?.orderId ?? order?.order_id ?? ''),
      items: orderItemText(order),
      amount: money(orderAmount(order)),
      codes: codes.length ? codes.join('; ') : '无',
      mode: deliveryModeLabel(mode),
      buyer: String(order?.buyerInfo?.name || order?.buyerName || '买家'),
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    }
    return Object.entries(variables).reduce(
      (text, [key, value]) => text.split(`{${key}}`).join(value),
      template,
    )
  }

  async function deliverOne(order, cookie) {
    const delivery = deliveryConfig()
    const mode = delivery.mode || 'no-logistics'
    const orderId = String(order?.orderId ?? order?.order_id ?? '')
    if (!orderId) throw new Error('订单缺少 orderId，无法发货')

    const param = {
      from: 'pc',
      orderId,
      expressNo: '',
      expressType: '0',
      expressCustom: '',
      fullDeliver: true,
    }
    let codes = []
    if (mode === 'express') {
      param.expressType = String(delivery.expressType ?? '0')
      param.expressNo = String(delivery.expressNo || '')
      param.expressCustom = String(delivery.expressCustom || '')
      if (Number(param.expressType) !== 0 && !param.expressNo) throw new Error('快递模式必须配置 expressNo')
    } else if (mode === 'ecode') {
      const quantity = orderItems(order).reduce((sum, item) => sum + Math.max(1, Number(item?.quantity ?? item?.num ?? 1)), 0)
      codes = pickCodes(Math.max(1, quantity))
      if (!codes.length) throw new Error('卡密池已用尽，请配置 autoDelivery.eCodes 或重置发货状态')
      param.eCodeList = codes.map((code) => ({ eCode: code }))
      param.expressType = '0'
    }

    if (delivery.dryRun) {
      return { ok: true, dryRun: true, codes, message: '演练模式，未实际发货' }
    }

    let lastError
    const attempts = Math.max(1, Number(delivery.retryAttempts ?? 2) + 1)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await wdApi(WD_ORDER_DELIVER_API, param, cookie)
        return { ok: true, codes, message: '发货成功' }
      } catch (error) {
        lastError = error
        if (attempt < attempts) await sleep(1000 * attempt)
      }
    }
    return { ok: false, codes, message: lastError?.message || '发货失败' }
  }

  async function runAutoDelivery() {
    if (deliveryInProgress) return { summary: '已有自动发货任务正在执行，请稍后再试。', lines: [] }
    const delivery = deliveryConfig()
    if (!deliveryEnabled()) return { summary: '自动发货未启用。可发送「微店发货开启」临时开启。', lines: [] }
    const cookie = deliveryCookie()
    if (!cookie) return { summary: '没有可用的微店 Cookie，请先登录或设置 Cookie。', lines: [] }

    deliveryInProgress = true
    const lines = []
    let total = 0
    let success = 0
    let failed = 0
    let skipped = 0
    try {
      const orders = await fetchPaidOrders(cookie)
      total = orders.length
      const limit = Math.min(orders.length, Math.max(1, Number(delivery.maxPerRun) || 20))
      for (const order of orders.slice(0, limit)) {
        const orderId = String(order?.orderId ?? order?.order_id ?? '')
        if (!isPaidOrder(order)) {
          skipped += 1
          continue
        }
        if (state.delivery.processed[orderId]) {
          skipped += 1
          continue
        }
        if (!matchesDeliveryFilter(order, delivery)) {
          skipped += 1
          continue
        }
        if (Number(delivery.minAmount || 0) > 0 && orderAmount(order) < Number(delivery.minAmount)) {
          skipped += 1
          continue
        }
        try {
          const result = await deliverOne(order, cookie)
          state.delivery.processed[orderId] = {
            at: Date.now(), ok: result.ok, dryRun: !!result.dryRun,
            mode: delivery.mode || 'no-logistics', codes: result.codes, message: result.message,
          }
          if (result.ok && !result.dryRun) {
            for (const code of result.codes) {
              if (!state.delivery.usedCodes.includes(code)) state.delivery.usedCodes.push(code)
            }
            success += 1
            if (delivery.channels?.length) {
              await broadcast(delivery.channels, renderDelivery(
                delivery.template || DEFAULT_DELIVERY_TEMPLATE, order, result.codes, delivery.mode || 'no-logistics',
              ))
            }
            lines.push(`✅ ${orderId} ${result.message}`)
          } else if (result.ok && result.dryRun) {
            skipped += 1
            lines.push(`🔎 ${orderId} 演练：${result.message}`)
          } else {
            failed += 1
            lines.push(`❌ ${orderId} ${result.message}`)
          }
        } catch (error) {
          failed += 1
          lines.push(`❌ ${orderId} ${error.message}`)
        }
        await saveState()
      }
      state.delivery.lastRun = Date.now()
      state.delivery.lastSummary = `待发货 ${total}，成功 ${success}，失败 ${failed}，跳过 ${skipped}`
      await saveState()
      return { summary: state.delivery.lastSummary, lines, total, success, failed, skipped }
    } catch (error) {
      logger.warn(`自动发货失败：${error.message}`)
      return { summary: `自动发货失败：${error.message}`, lines, total, success, failed, skipped }
    } finally {
      deliveryInProgress = false
    }
  }

  function render(template, project, snapshot, previous) {
    const diff = previous ? snapshot.amount - previous.amount : 0
    const supporterDiff = previous ? snapshot.supporters - previous.supporters : 0
    const variables = {
      project: project.name || project.id,
      name: snapshot.name || project.name || project.id,
      amount: money(snapshot.amount),
      diff: money(Math.abs(diff)),
      change: diff >= 0 ? '新增' : '减少',
      supporters: String(snapshot.supporters),
      supporterDiff: String(Math.abs(supporterDiff)),
      link: snapshot.link,
      platform: project.platform,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    }
    return Object.entries(variables).reduce(
      (text, [key, value]) => text.split(`{${key}}`).join(value),
      template,
    )
  }

  async function poll(index, silent = false) {
    const project = config.projects[index]
    if (!project || !isEnabled(index)) return null
    const key = projectKey(project)
    try {
      const loginCookie = config.autoUseLoginCookie ? state.login?.cookie : undefined
      const snapshot = await fetchSnapshot(ctx, project, config.requestTimeout, loginCookie)
      const previous = state.snapshots[key]
      state.snapshots[key] = snapshot
      await saveState()

      if (!silent && previous && (snapshot.amount !== previous.amount || snapshot.supporters !== previous.supporters)) {
        const template = state.globalThanks || project.thanks || DEFAULT_TEMPLATE
        await broadcast(project.channels, render(template, project, snapshot, previous))
      } else if (!silent && !previous && config.noticeOnStart) {
        await broadcast(project.channels, render(template0(project), project, snapshot, null))
      }
      return snapshot
    } catch (error) {
      logger.warn(`抓取 ${project.platform}:${project.id} 失败：${error.message}`)
      return null
    }
  }

  function template0(project) {
    return state.globalThanks || project.thanks || DEFAULT_TEMPLATE
  }

  function formatProject(index, project) {
    const snapshot = state.snapshots[projectKey(project)]
    const status = isEnabled(index) ? '监控中' : '已关闭'
    if (!snapshot) return `${index + 1}. [${project.platform}] ${project.name || project.id} —— ${status}，暂无数据`
    return `${index + 1}. [${project.platform}] ${project.name || snapshot.name} —— ${status}\n`
      + `   金额：${money(snapshot.amount)} 元｜人数：${snapshot.supporters}\n`
      + `   更新：${new Date(snapshot.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`
      + `   链接：${snapshot.link}`
  }

  function maskCookie(cookie) {
    if (!cookie) return '(无)'
    if (cookie.length <= 24) return `${cookie.slice(0, 6)}***`
    return `${cookie.slice(0, 12)}...${cookie.slice(-8)}（共 ${cookie.length} 字符）`
  }

  function serializeCookies(cookies) {
    return cookies
      .filter((item) => !config.cookieDomains.length || config.cookieDomains.some((domain) => item.domain.includes(domain)))
      .map((item) => `${item.name}=${item.value}`)
      .join('; ')
  }

  async function isLoggedIn(page, cookies) {
    const authCookies = cookies.filter((item) =>
      /uid|user|token|skey|session|ticket|auth|login/i.test(item.name)
      && item.value && item.value.length > 8)
    if (!authCookies.length) return false
    if (/login|passport|signin/i.test(page.url())) return false
    try {
      const text = await page.evaluate(() => document.body?.innerText || '')
      if (/退出登录|我的小店|店铺管理|个人中心|账号中心/.test(text)) return true
    } catch {
      // 页面结构变化不影响按 Cookie 判断
    }
    return authCookies.length >= 2
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function splitList(value) {
    return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
  }

  async function findHandle(page, selectors) {
    for (const selector of splitList(selectors)) {
      try {
        const handle = await page.$(selector)
        if (handle) return handle
      } catch {
        // 选择器不被当前页面支持时继续尝试下一个
      }
    }
    return null
  }

  async function typeInto(page, selectors, value) {
    const handle = await findHandle(page, selectors)
    if (!handle) throw new Error(`页面上找不到输入框（${splitList(selectors)[0]}），请检查选择器配置`)
    try {
      await handle.click({ clickCount: 3 })
      await handle.type(String(value), { delay: 10 })
    } finally {
      await handle.dispose()
    }
  }

  async function clickByText(page, labels) {
    for (const label of splitList(labels)) {
      const clicked = await page.evaluate((text) => {
        const nodes = Array.from(document.querySelectorAll('button, a, span, div, li, input[type="button"], input[type="submit"]'))
          .filter((node) => node.getClientRects && node.getClientRects().length)
        const normalize = (value) => (value || '').replace(/\s+/g, '')
        const target = normalize(text)
        const exact = nodes.find((node) => normalize(node.textContent) === target)
        const partial = nodes.find((node) => normalize(node.textContent).includes(target))
        const node = exact || partial
        if (!node) return false
        node.click()
        return true
      }, label)
      if (clicked) return true
    }
    return false
  }

  // 登录页默认可能停在二维码视图，先切回账号表单，再点具体的登录方式标签。
  async function ensureAccountForm(page, tabLabels) {
    const switchHandle = await findHandle(page, ['.login-img', '.qrcode-or-login .login-img'])
    if (switchHandle) {
      try {
        await switchHandle.click()
      } catch {
        // 已在表单视图时元素不可见，忽略
      } finally {
        await switchHandle.dispose()
      }
      await sleep(300)
    }
    await clickByText(page, tabLabels)
    await sleep(300)
  }

  async function ensureAgreement(page) {
    const handle = await findHandle(page, ['.agreement-login .el-checkbox', '.agreement-login .el-checkbox__input'])
    if (!handle) return
    try {
      const checked = await page.evaluate((node) => {
        const input = node.querySelector('input')
        return input ? !!input.checked : node.classList.contains('is-checked')
      }, handle)
      if (!checked) await handle.click()
    } catch (error) {
      logger.warn(`勾选服务协议失败：${error.message}`)
    } finally {
      await handle.dispose()
    }
  }

  async function detectCaptcha(page) {
    try {
      return await page.evaluate(() => {
        const frames = Array.from(document.querySelectorAll('iframe'))
          .some((frame) => /captcha|verify/i.test(`${frame.src || ''} ${frame.id || ''}`))
        const overlays = Array.from(document.querySelectorAll('[id*="tcaptcha"], [class*="captcha"], [class*="verify-slide"]'))
          .some((node) => node.getClientRects && node.getClientRects().length)
        return frames || overlays
      })
    } catch {
      return false
    }
  }

  // 微店使用腾讯滑块验证，自动滑动仅作尽力尝试；不通过时回退扫码或手动 Cookie。
  async function solveCaptcha(page) {
    const targets = []
    if (typeof page.frames === 'function') {
      for (const frame of page.frames()) {
        if (/captcha/i.test(typeof frame.url === 'function' ? frame.url() : '')) targets.push(frame)
      }
    }
    targets.push(page)
    for (const target of targets) {
      for (const selector of ['#tcaptcha_drag_thumb', '.tc-drag-thumb', '[class*="drag-thumb"]', '#nc_1_n1z', '[class*="btn_slide"]']) {
        let handle
        try {
          handle = await target.$(selector)
        } catch {
          continue
        }
        if (!handle) continue
        try {
          const box = await handle.boundingBox()
          if (!box) continue
          let x = box.x + box.width / 2
          let y = box.y + box.height / 2
          if (target !== page && typeof target.frameElement === 'function') {
            const container = await target.frameElement()
            const frameBox = container && await container.boundingBox()
            if (frameBox) {
              x += frameBox.x
              y += frameBox.y
            }
          }
          await page.mouse.move(x, y)
          await page.mouse.down()
          await page.mouse.move(x + 260, y, { steps: 30 })
          await page.mouse.up()
          await sleep(1500)
          return true
        } catch {
          // 换下一个滑块选择器
        } finally {
          await handle.dispose()
        }
      }
    }
    return false
  }

  async function readToast(page) {
    try {
      return await page.evaluate(() => Array.from(document.querySelectorAll('.el-message__content, .wd-toast, [class*="toast"]'))
        .map((node) => (node.textContent || '').trim())
        .filter(Boolean)
        .join(' | '))
    } catch {
      return ''
    }
  }

  async function waitForLogin(page, timeout) {
    const deadline = Date.now() + timeout * 1000
    let lastToast = ''
    while (Date.now() < deadline) {
      let cookies = []
      try {
        cookies = await page.cookies()
      } catch {
        // 页面关闭时由外层统一处理
      }
      if (await isLoggedIn(page, cookies)) return { ok: true }
      const toast = await readToast(page)
      if (toast && toast !== lastToast && /错误|失败|不正确|不存在|过期|无效|频繁|超限|冻结|锁定|异常|请阅读|手机号|密码|验证码/.test(toast)) {
        return { ok: false, error: toast }
      }
      if (await detectCaptcha(page)) {
        if (config.autoSlideCaptcha && await solveCaptcha(page)) {
          await sleep(1500)
          continue
        }
        return { ok: false, captcha: true, error: '安全验证未通过' }
      }
      await sleep(1000)
    }
    return { ok: false, error: `等待登录结果超时（${timeout} 秒）` }
  }

  async function saveLogin(page, source, label) {
    // 回到店铺首页，补齐同源 Cookie
    try {
      await page.goto('https://d.weidian.com/', { waitUntil: 'domcontentloaded', timeout: config.requestTimeout * 1000 })
    } catch {
      // 跳转失败时使用当前页面 Cookie
    }
    const all = await page.cookies()
    const cookie = serializeCookies(all)
    if (!cookie) throw new Error('登录成功但未提取到 Cookie，请检查 cookieDomains 配置')
    state.login = { cookie, savedAt: Date.now(), source }
    await saveState()
    return `${label}登录成功，已提取并保存 ${all.length} 条 Cookie：${maskCookie(cookie)}`
  }

  function requirePuppeteer() {
    if (!ctx.puppeteer || typeof ctx.puppeteer.page !== 'function') {
      return '未检测到浏览器服务。请先安装并启用 koishi-plugin-puppeteer 插件后再使用登录功能。'
    }
    return null
  }

  async function clearPendingLogin(userId, close = true) {
    const pending = pendingLogins.get(userId)
    if (!pending) return
    if (pending.timer) clearTimeout(pending.timer)
    if (close && pending.page) {
      try {
        await pending.page.close()
      } catch {
        // 页面已关闭
      }
    }
    pendingLogins.delete(userId)
  }

  async function captureQr(page, session) {
    let screenshot
    try {
      const selector = config.qrSelector.trim()
      if (selector) {
        const handle = await page.$(selector)
        if (handle) {
          screenshot = await handle.screenshot({ type: 'png' })
          await handle.dispose()
        }
      }
    } catch (error) {
      logger.warn(`截取二维码元素失败，改用整页截图：${error.message}`)
    }
    if (!screenshot) screenshot = await page.screenshot({ type: 'png' })
    await session.send(h.image(screenshot, 'image/png'))
  }

  async function login(session) {
    const missing = requirePuppeteer()
    if (missing) return missing
    if (loginInProgress) return '已有登录流程正在进行，请等待完成或超时后再试。'
    loginInProgress = true
    let page
    try {
      page = await ctx.puppeteer.page()
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.requestTimeout * 1000 })
      await sleep(500)
      // 微店登录页默认显示账号表单，点二维码图标切到扫码视图；兼容其他文案入口。
      const qrHandle = await findHandle(page, ['.qrcode-img', '.scanQRcode'])
      if (qrHandle) {
        try {
          await qrHandle.click()
        } catch {
          // 元素不可见时忽略
        } finally {
          await qrHandle.dispose()
        }
      }
      for (const label of ['扫码登录', '微信扫码登录', '二维码登录', '企业微信扫码登录']) {
        try {
          if (await clickByText(page, label)) break
        } catch {
          // 页面没有该入口则继续尝试下一个
        }
      }
      await sleep(500)
      await captureQr(page, session)
      await session.send('请使用微信或微店 App 扫描二维码并在手机上确认；登录完成后我会自动保存 Cookie。')

      const deadline = Date.now() + config.loginTimeout * 1000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const cookies = await page.cookies()
        if (await isLoggedIn(page, cookies)) {
          // 回到店铺首页，补齐同源 Cookie
          try {
            await page.goto('https://d.weidian.com/', { waitUntil: 'domcontentloaded', timeout: config.requestTimeout * 1000 })
          } catch {
            // 跳转失败时使用当前页面 Cookie
          }
          return await saveLogin(page, 'qr', '扫码')
        }
      }
      return `扫码登录超时（${config.loginTimeout} 秒），可再次发送「微店登录」重试。`
    } catch (error) {
      logger.warn(`微店登录失败：${error.message}`)
      return `登录失败：${error.message}`
    } finally {
      if (page) {
        try {
          await page.close()
        } catch {
          // 页面已关闭
        }
      }
      loginInProgress = false
    }
  }

  async function sendScreenshot(page, session, text) {
    try {
      const image = await page.screenshot({ type: 'png' })
      await session.send(h.image(image, 'image/png'))
    } catch (error) {
      logger.warn(`发送验证截图失败：${error.message}`)
    }
    try {
      await session.send(text)
    } catch {
      // 会话可能已失效
    }
  }

  async function submitLoginButton(page) {
    // 优先点真实页面上的 .weidian-button，避免「登录」文案误点到标签页
    const button = await findHandle(page, ['button.weidian-button', '.weidian-button'])
    if (button) {
      try {
        await button.click()
        return true
      } finally {
        await button.dispose()
      }
    }
    return clickByText(page, '进入微店, 立即登录')
  }

  async function loginWithPassword(session, account, password) {
    const missing = requirePuppeteer()
    if (missing) return missing
    if (loginInProgress) return '已有登录流程正在进行，请等待完成或超时后再试。'
    loginInProgress = true
    let page
    try {
      page = await ctx.puppeteer.page()
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.requestTimeout * 1000 })
      await sleep(500)
      await ensureAccountForm(page, '密码登录')
      await typeInto(page, config.phoneSelector, account)
      await typeInto(page, config.passwordSelector, password)
      await ensureAgreement(page)
      if (await detectCaptcha(page) && config.autoSlideCaptcha) await solveCaptcha(page)
      if (!await submitLoginButton(page)) throw new Error('找不到登录按钮，请检查页面结构或选择器配置')
      const result = await waitForLogin(page, config.loginTimeout)
      if (!result.ok) {
        if (result.captcha) {
          await sendScreenshot(page, session, '密码登录触发了安全验证，自动滑动未通过。请改用「微店登录」扫码，或「微店Cookie」手动设置。')
        }
        return `密码登录失败：${result.error}`
      }
      return await saveLogin(page, 'password', '密码')
    } catch (error) {
      logger.warn(`微店密码登录失败：${error.message}`)
      return `密码登录失败：${error.message}`
    } finally {
      if (page) {
        try {
          await page.close()
        } catch {
          // 页面已关闭
        }
      }
      loginInProgress = false
    }
  }

  async function loginWithSubAccount(session, phone, account, password) {
    const missing = requirePuppeteer()
    if (missing) return missing
    if (loginInProgress) return '已有登录流程正在进行，请等待完成或超时后再试。'
    const normalizedPhone = String(phone || '').trim()
    if (!/^\d{11}$/.test(normalizedPhone)) return '请输入 11 位绑定手机号，例如：微店子账号登录 13800138000 发货员 密码'
    loginInProgress = true
    let page
    try {
      page = await ctx.puppeteer.page()
      await page.goto(config.subAccountLoginUrl || WD_SUB_ACCOUNT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.requestTimeout * 1000 })
      await sleep(500)
      await typeInto(page, config.phoneSelector, normalizedPhone)
      await typeInto(page, config.subAccountSelector, account)
      await typeInto(page, config.passwordSelector, password)
      await ensureAgreement(page)
      if (await detectCaptcha(page) && config.autoSlideCaptcha) await solveCaptcha(page)
      if (!await submitLoginButton(page)) throw new Error('找不到登录按钮，请检查页面结构或选择器配置')
      const result = await waitForLogin(page, config.loginTimeout)
      if (!result.ok) {
        if (result.captcha) {
          await sendScreenshot(page, session, '子账号登录触发了安全验证，自动滑动未通过。请改用扫码登录或手动 Cookie。')
        }
        return `子账号登录失败：${result.error}`
      }
      return await saveLogin(page, 'subaccount', '子账号')
    } catch (error) {
      logger.warn(`微店子账号登录失败：${error.message}`)
      return `子账号登录失败：${error.message}`
    } finally {
      if (page) {
        try {
          await page.close()
        } catch {
          // 页面已关闭
        }
      }
      loginInProgress = false
    }
  }

  async function requestSmsCode(session, phone) {
    const missing = requirePuppeteer()
    if (missing) return missing
    const normalized = String(phone || '').trim()
    if (!/^\d{11}$/.test(normalized)) return '请输入 11 位手机号，例如：微店短信登录 13800138000'
    const existing = pendingLogins.get(session.userId)
    if (existing) {
      if (existing.expiresAt > Date.now()) {
        return `已有待验证的短信登录（${existing.phone}），请发送「微店验证码 <验证码>」，或先发送「微店登录取消」。`
      }
      await clearPendingLogin(session.userId)
    }
    let page
    try {
      page = await ctx.puppeteer.page()
      await page.goto(config.loginUrl, { waitUntil: 'domcontentloaded', timeout: config.requestTimeout * 1000 })
      await sleep(500)
      await ensureAccountForm(page, '验证码登录注册, 验证码登录, 短信登录')
      await typeInto(page, config.phoneSelector, normalized)
      await ensureAgreement(page)
      if (await detectCaptcha(page) && config.autoSlideCaptcha && !await solveCaptcha(page)) {
        await sendScreenshot(page, session, '发送验证码前触发了安全验证，自动滑动未通过。请改用扫码登录或手动 Cookie。')
        throw new Error('安全验证未通过')
      }
      let sent = await clickByText(page, '获取验证码, 发送验证码')
      if (!sent) {
        const button = await findHandle(page, ['.message-code-button', '[class*="message-code-button"]'])
        if (button) {
          try {
            await button.click()
            sent = true
          } finally {
            await button.dispose()
          }
        }
      }
      if (!sent) throw new Error('找不到获取验证码按钮，请检查页面结构或选择器配置')
      await sleep(1200)
      const toast = await readToast(page)
      if (/错误|失败|频繁|超限|格式/.test(toast)) throw new Error(toast)

      const expiresAt = Date.now() + config.loginTimeout * 1000
      const pending = { page, phone: normalized, expiresAt, session }
      pending.timer = setTimeout(async () => {
        if (pendingLogins.get(session.userId) !== pending) return
        await clearPendingLogin(session.userId)
        try {
          await session.send(`短信验证码登录已超时（${config.loginTimeout} 秒），请重新发送「微店短信登录 ${normalized}」。`)
        } catch {
          // 会话可能已失效
        }
      }, config.loginTimeout * 1000)
      if (typeof pending.timer.unref === 'function') pending.timer.unref()
      pendingLogins.set(session.userId, pending)
      return `验证码已发送至 ${normalized.slice(0, 3)}****${normalized.slice(-4)}，请在 ${config.loginTimeout} 秒内发送「微店验证码 123456」。`
    } catch (error) {
      if (page) {
        try {
          await page.close()
        } catch {
          // 页面已关闭
        }
      }
      logger.warn(`微店短信验证码发送失败：${error.message}`)
      return `短信验证码发送失败：${error.message}`
    }
  }

  async function submitSmsCode(session, code) {
    const pending = pendingLogins.get(session.userId)
    if (!pending) return '当前没有待验证的短信登录。请先发送「微店短信登录 <手机号>」。'
    if (pending.expiresAt <= Date.now()) {
      await clearPendingLogin(session.userId)
      return '短信验证码登录已超时，请重新发送「微店短信登录 <手机号>」。'
    }
    const value = String(code || '').trim()
    if (!/^\d{4,8}$/.test(value)) return '验证码应为 4~8 位数字，请重新发送「微店验证码 <验证码>」。'
    try {
      await typeInto(pending.page, config.smsCodeSelector, value)
      await ensureAgreement(pending.page)
      if (await detectCaptcha(pending.page) && config.autoSlideCaptcha && !await solveCaptcha(pending.page)) {
        await sendScreenshot(pending.page, session, '短信登录触发了安全验证，自动滑动未通过。请改用扫码登录或手动 Cookie。')
        await clearPendingLogin(session.userId)
        return '安全验证未通过，本次短信登录已取消。'
      }
      if (!await submitLoginButton(pending.page)) throw new Error('找不到登录按钮，请检查页面结构或选择器配置')
      const result = await waitForLogin(pending.page, config.loginTimeout)
      if (!result.ok) {
        if (result.captcha) {
          await sendScreenshot(pending.page, session, '短信登录触发了安全验证，自动滑动未通过。请改用扫码登录或手动 Cookie。')
        }
        await clearPendingLogin(session.userId)
        return `短信登录失败：${result.error}`
      }
      const message = await saveLogin(pending.page, 'sms', '短信')
      await clearPendingLogin(session.userId)
      return message
    } catch (error) {
      await clearPendingLogin(session.userId)
      logger.warn(`微店短信登录失败：${error.message}`)
      return `短信登录失败：${error.message}`
    }
  }

  async function cancelLogin(session) {
    if (!pendingLogins.has(session.userId)) return '当前没有待验证的短信登录。'
    await clearPendingLogin(session.userId)
    return '已取消短信验证码登录。'
  }

  ctx.on('ready', async () => {
    if (started) return
    started = true
    await loadState()
    // 先静默抓取一次建立基线，避免重启后重复播报旧数据
    await Promise.all(config.projects.map((_, index) => poll(index, true)))
    config.projects.forEach((project, index) => {
      timers.push(ctx.setInterval(() => poll(index), Math.max(10, project.interval) * 1000))
    })
    if (deliveryEnabled()) {
      timers.push(ctx.setInterval(() => {
        if (!deliveryInProgress) runAutoDelivery().catch((error) => logger.warn(`自动发货异常：${error.message}`))
      }, Math.max(10, Number(deliveryConfig().interval) || 30) * 1000))
      logger.info('微店订单自动发货已启动')
    }
    logger.info(`微店监控已启动，共 ${config.projects.length} 个项目`)
  })

  ctx.on('dispose', () => {
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
    for (const userId of Array.from(pendingLogins.keys())) clearPendingLogin(userId)
  })

  ctx.command('微店状态', '查看当前监控的项目与集资数据')
    .alias('微店召唤')
    .action(() => {
      if (!config.projects.length) return '当前没有配置监控项目，请先在插件配置中添加 projects。'
      return config.projects.map((project, index) => formatProject(index, project)).join('\n\n')
    })

  ctx.command('微店查询 <index:posint>', '查看某个项目的详细信息')
    .action(({ session }, index) => {
      const project = config.projects[index - 1]
      if (!project) return `没有第 ${index} 个监控项目。`
      return formatProject(index - 1, project)
    })

  ctx.command('微店测试', '立即刷新全部项目（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      if (!config.projects.length) return '当前没有配置监控项目。'
      const results = await Promise.all(config.projects.map((_, index) => poll(index, true)))
      return results.map((snapshot, index) => snapshot
        ? `${index + 1}. ${money(snapshot.amount)} 元 / ${snapshot.supporters} 人`
        : `${index + 1}. 抓取失败，请查看日志`).join('\n')
    })

  ctx.command('微店开启 <index:posint>', '开启某个项目的监控（管理员）')
    .action(async ({ session }, index) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      if (!config.projects[index - 1]) return `没有第 ${index} 个监控项目。`
      state.enabled[index - 1] = true
      await saveState()
      return `已开启第 ${index} 个项目的监控。`
    })

  ctx.command('微店关闭 <index:posint>', '关闭某个项目的监控（管理员）')
    .action(async ({ session }, index) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      if (!config.projects[index - 1]) return `没有第 ${index} 个监控项目。`
      state.enabled[index - 1] = false
      await saveState()
      return `已关闭第 ${index} 个项目的监控。`
    })

  ctx.command('微店感谢 <template:text>', '设置全局播报模板（管理员，传入空内容则恢复项目自身模板）')
    .action(async ({ session }, template) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      state.globalThanks = (template || '').trim()
      await saveState()
      return state.globalThanks ? `播报模板已设为：${state.globalThanks}` : '已恢复各项目自己的播报模板。'
    })

  ctx.command('微店登录', '扫码登录微店并自动提取 Cookie（管理员，建议私聊）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      return login(session)
    })

  ctx.command('微店密码登录 <account:string> <password:string>', '使用手机号与密码登录微店（管理员，建议私聊）')
    .action(async ({ session }, account, password) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      return loginWithPassword(session, account, password)
    })

  ctx.command('微店短信登录 <phone:string>', '获取短信验证码登录微店（管理员，建议私聊）')
    .action(async ({ session }, phone) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      return requestSmsCode(session, phone)
    })

  ctx.command('微店验证码 <code:string>', '提交短信验证码，完成微店登录（管理员）')
    .action(async ({ session }, code) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      return submitSmsCode(session, code)
    })

  ctx.command('微店登录取消', '取消进行中的短信验证码登录（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      return cancelLogin(session)
    })

  ctx.command('微店Cookie [cookie:text]', '查看、设置或清除保存的 Cookie（管理员）')
    .alias('微店登录状态')
    .action(async ({ session }, cookie) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      if (cookie === undefined || !cookie.trim()) {
        if (!state.login) return '当前没有保存的 Cookie。可发送「微店登录」「微店密码登录」「微店短信登录」，或用「微店Cookie <内容>」手动设置。'
        const sourceLabel = { qr: '扫码登录', password: '密码登录', sms: '短信登录', subaccount: '子账号登录', manual: '手动设置' }
        return `已保存 Cookie：${maskCookie(state.login.cookie)}\n`
          + `来源：${sourceLabel[state.login.source] || '手动设置'}\n`
          + `保存时间：${new Date(state.login.savedAt).toLocaleString('zh-CN')}`
      }
      const value = cookie.trim()
      if (value === 'clear' || value === '清除') {
        state.login = null
        await saveState()
        return '已清除保存的 Cookie。'
      }
      state.login = { cookie: value, savedAt: Date.now(), source: 'manual' }
      await saveState()
      return `Cookie 已保存：${maskCookie(value)}`
    })

  ctx.command('微店子账号登录 <phone:string> <account:string> <password:string>', '用微店子账号登录并自动提取 Cookie（管理员，强烈建议私聊）')
    .action(async ({ session }, phone, account, password) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      return loginWithSubAccount(session, phone, account, password)
    })

  ctx.command('微店发货', '立即执行一次订单自动发货（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      const result = await runAutoDelivery()
      return [result.summary, ...result.lines].join('\n')
    })

  ctx.command('微店发货开启', '临时开启自动发货（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      state.delivery.enabled = true
      await saveState()
      return '自动发货已开启。'
    })

  ctx.command('微店发货关闭', '临时关闭自动发货（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      state.delivery.enabled = false
      await saveState()
      return '自动发货已关闭。'
    })

  ctx.command('微店发货状态', '查看自动发货状态（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      const processed = Object.keys(state.delivery.processed || {}).length
      const lastCodes = (state.delivery.usedCodes || []).length
      const lastRun = state.delivery.lastRun
        ? new Date(state.delivery.lastRun).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
        : '尚未运行'
      return [
        `自动发货：${deliveryEnabled() ? '已启用' : '已关闭'}（${state.delivery.enabled === null ? '跟随配置' : '命令覆盖'}）`,
        `发货方式：${deliveryModeLabel(deliveryConfig().mode || 'no-logistics')}`,
        `Cookie：${maskCookie(deliveryCookie())}`,
        `已处理订单：${processed}｜已用卡密：${lastCodes}`,
        `最近运行：${lastRun}`,
        `最近结果：${state.delivery.lastSummary || '无'}`,
      ].join('\n')
    })

  ctx.command('微店发货重置', '清空发货去重记录与卡密使用记录（管理员）')
    .action(async ({ session }) => {
      if (!isAdmin(session)) return '您没有权限执行此命令。'
      state.delivery.processed = {}
      state.delivery.usedCodes = []
      state.delivery.lastRun = 0
      state.delivery.lastSummary = ''
      await saveState()
      return '已清空发货记录与卡密使用记录。'
    })

  ctx.command('微店帮助', '查看微店监控插件的命令')
    .action(() => [
      '微店监控插件命令：',
      '  微店状态 / 微店召唤 —— 查看项目金额、人数与链接',
      '  微店查询 <序号> —— 查看指定项目详情',
      '  微店测试 —— 立即刷新全部项目（管理员）',
      '  微店开启/关闭 <序号> —— 开关监控（管理员）',
      '  微店感谢 <模板> —— 设置播报模板（管理员）',
      '  微店登录 —— 扫码登录并自动提取 Cookie（管理员）',
      '  微店密码登录 <账号> <密码> —— 手机号 + 密码登录（管理员，建议私聊）',
      '  微店短信登录 <手机号> —— 发送短信验证码（管理员，建议私聊）',
      '  微店验证码 <验证码> —— 完成短信登录（管理员）',
      '  微店登录取消 —— 取消待验证的短信登录（管理员）',
      '  微店子账号登录 <手机号> <子账号> <密码> —— 用权限子账号登录（管理员，建议私聊）',
      '  微店Cookie [内容] —— 查看/设置/清除 Cookie（管理员）',
      '  微店发货 —— 立即执行一次自动发货（管理员）',
      '  微店发货开启/关闭 —— 临时开关自动发货（管理员）',
      '  微店发货状态 —— 查看发货进度与卡密用量（管理员）',
      '  微店发货重置 —— 清空发货与卡密记录（管理员）',
      '监控模板变量：{project} {name} {amount} {diff} {change} {supporters} {link}',
      '发货模板变量：{orderId} {items} {amount} {codes} {mode} {buyer} {time}',
    ].join('\n'))
}
