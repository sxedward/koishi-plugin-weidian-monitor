# @sxedward/koishi-plugin-weidian-monitor

微店 / 摩点 / OWHAT / 桃叭 众筹监控与**微店订单自动发货**插件，适用于 **Koishi v4**。

功能参考 CoolQ 插件 `me.cqp.lyt.modianMonitor`（应援 3.65）：轮询众筹项目数据，金额/人数变化时向指定群播报；并新增微店商家后台订单自动发货。

- **登录只在 Koishi 插件配置页进行**，QQ / 群聊中已移除所有登录命令。
- **订单播报只播报新付款订单，不播报发货结果**；发货过程保持静默。

## 安装

```bash
npm install @sxedward/koishi-plugin-weidian-monitor
```

旧包名 `koishi-plugin-weidian-monitor` 已弃用，请改用上面的新作用域包；Koishi 控制台可执行 `koishi add sxedward/koishi-plugin-weidian-monitor` 安装。

无需编译（CommonJS）。在 `koishi.yml` 中启用：

```yaml
plugins:
  puppeteer:                    # 账号密码 / 短信登录需要浏览器服务
  weidian-monitor:
    admins:
      - 'onebot:10000'          # 管理员的用户 ID
    requestTimeout: 10
    noticeOnStart: false
    loginUrl: 'https://d.weidian.com/'
    loginTimeout: 180
    cookieDomains: ['weidian.com']
    autoUseLoginCookie: true
    autoSlideCaptcha: true
    login:                      # 登录只在插件配置页进行
      mode: password            # none / cookie / password / sms / subaccount
      phone: '13800138000'
      password: 'yourpassword'
      # subAccount: '发货员'    # mode=subaccount 时填写
      # cookie: ''              # mode=cookie 时直接粘贴 Cookie
      # requestSmsCode: false   # mode=sms 第一步设为 true
      # smsCode: ''             # mode=sms 第二步填写收到的验证码
    autoDelivery:               # 微店订单自动发货
      enabled: false            # 默认关闭；运行时用「微店发货开启/关闭」切换
      interval: 30
      # cookie: ''              # 留空则复用 login 保存的 Cookie
      mode: no-logistics        # no-logistics / ecode / express
      noticeOnPaid: true        # 付款播报开关；发货不播报
      channels:                 # 付款播报群
        - 'onebot:987654321'
      paidTemplate: '【新订单】订单 {orderId} 已付款\n商品：{items}\n金额：{amount} 元\n时间：{time}'
      # 快递模式再配置 expressType / expressNo / expressCustom
      # 卡券模式再配置 eCodes（按顺序消费，已用卡密记录在状态文件）
      # 可选用 itemIds / skuIds / itemTitles / minAmount 限制发货范围
      # dryRun: true            # 演练模式，只记录不实际发货
    projects:
      - platform: weidian
        id: '123456789'
        name: '某某应援企划'
        channels:
          - 'onebot:987654321'
        interval: 60
        thanks: '【{project}】+{diff} 元，当前 {amount} 元，{supporters} 人\n{link}'
```

## 命令

QQ / 群聊中**没有登录命令**。

| 命令 | 说明 |
| --- | --- |
| `微店状态`（别名 `微店召唤`） | 查看所有项目的金额、人数、更新时间与链接 |
| `微店查询 <序号>` | 查看指定项目详情 |
| `微店测试` | 立即抓取全部项目（管理员） |
| `微店开启 <序号>` / `微店关闭 <序号>` | 开关某个项目的监控（管理员） |
| `微店感谢 <模板>` | 设置全局项目播报模板（管理员） |
| `微店发货` | 手动执行一次发货，即使定时开关关闭也可用（管理员） |
| `微店发货开启` / `微店发货关闭` | 运行时开关定时发货，状态保存到本地（管理员） |
| `微店发货状态` | 查看开关、Cookie、进度与最近结果（管理员） |
| `微店发货重置` | 清空发货去重、卡密与付款播报记录（管理员） |
| `微店帮助` | 查看命令列表 |

项目播报模板变量：`{project}` 项目名、`{name}` 平台返回名、`{amount}` 当前金额、`{diff}` 变化金额、`{change}` 新增/减少、`{supporters}` 参与人数、`{link}` 项目链接、`{time}` 时间。

付款播报模板变量：`{orderId}` 订单号、`{items}` 商品、`{amount}` 金额、`{buyer}` 买家、`{time}` 时间。

## 登录（仅在 Koishi 插件配置页）

账号密码 / 短信 / 子账号登录依赖浏览器服务，先安装并启用它（Koishi 官方 Docker 镜像已自带 Chromium）：

```bash
npm install koishi-plugin-puppeteer
```

在插件配置页的 `login` 段选择 `mode`：

| `mode` | 需要填写 | 行为 |
| --- | --- | --- |
| `none` | 无 | 不登录；只监控不需要登录的项目 |
| `cookie` | `cookie` | 直接粘贴浏览器里复制的 Cookie，无需浏览器 |
| `password` | `phone`、`password` | 用手机号 + 密码登录并自动提取 Cookie |
| `subaccount` | `phone`、`subAccount`、`password` | 用权限子账号登录，推荐用于自动发货 |
| `sms` | 见下文两步 | 短信验证码登录 |

### 短信验证码登录（两步）

1. 填写 `login.mode: sms`、`login.phone`，把 `login.requestSmsCode` 设为 `true`，保存配置；插件会打开登录页、填入手机号并点击“获取验证码”，然后保留浏览器页面等待验证码；
2. 收到短信后，把 `login.requestSmsCode` 改回 `false`，把验证码填入 `login.smsCode`，保存配置；插件会提交验证码并保存 Cookie。

等待时效由 `loginTimeout` 控制。若登录页改版，可通过 `phoneSelector`、`passwordSelector`、`smsCodeSelector`、`subAccountSelector`、`loginUrl`、`cookieDomains` 覆盖选择器与地址。

> 登录不在 QQ 中进行，验证码/密码不会出现在聊天记录里。验证失败时截图保存到 Koishi 工作目录的 `weidian-login-captcha.png`，并写入日志。

### 登录态的使用

- 保存的 Cookie 同时用于微店项目抓取和订单发货，不必重复登录。
- 项目自身配置的 `cookie` 优先级高于全局登录；`autoUseLoginCookie: false` 可关闭自动套用。
- `autoDelivery.cookie` 留空时复用全局登录；如需把发货与播报隔离才单独填写。
- Cookie 以明文保存在 `weidian-monitor-state.json`，请控制文件权限，不要泄露。

## 付款播报与自动发货

### 付款播报

插件定时拉取 `statusList: ['paid']` 的新付款订单，第一次看到某个订单时按 `autoDelivery.paidTemplate` 向 `autoDelivery.channels` 播报，并记录订单号避免重复播报。

- `noticeOnPaid: false` 可关闭付款播报；
- 发货成功/失败**不再发送群消息**，只在 `微店发货状态` 和日志中体现；
- 众筹项目的金额/人数变化播报不受影响，仍由每个项目的 `thanks` 模板控制。

### 自动发货开关

自动发货**默认关闭**。插件常驻一个订单轮询任务，付款播报始终进行，是否发货每轮读取运行时开关：

- `微店发货开启`：打开定时发货，状态写入本地文件，重启后仍保持；
- `微店发货关闭`：关闭定时发货；
- `微店发货`：忽略定时开关，立即手动执行一次；
- `微店发货状态`：查看当前开关、Cookie、已处理订单、卡密用量和最近结果。

配置中的 `autoDelivery.enabled` 只是初始值；运行后用命令开关会覆盖它。

插件定时调用微店商家后台接口：

- `seller.getOrderListForPC`：拉取待发货订单，并过滤退款中/已退款、拼团未成团、不可批量操作的订单；
- `seller.deliverOrder`：按配置方式发货。

### 发货方式

| `mode` | 说明 | 需要的配置 |
| --- | --- | --- |
| `no-logistics` | 无需物流发货（常见虚拟商品/应援商品） | 无 |
| `ecode` | 电子卡券码发货，按订单商品数量从卡密池顺序取码 | `eCodes` |
| `express` | 快递发货 | `expressType`、`expressNo`，可选 `expressCustom` |

可选项：

- `itemIds` / `skuIds` / `itemTitles`：限制只对指定商品发货，避免误发其他订单；
- `minAmount`：只处理金额不低于该值的订单；
- `dryRun: true`：演练模式，只记录不真正发货，建议首次上线前先开演练；
- `maxPerRun`、`retryAttempts`、`interval`：控制每轮处理量、失败重试与轮询频率。

安全设计：

- 已处理订单按 `orderId` 去重并记录在 `weidian-monitor-state.json`，重启不重复发货；
- 付款播报按 `orderId` 去重，重启不重复播报；
- `ecode` 模式已使用的卡密会单独记录，不会重复发放；如需重新分配，先执行 `微店发货重置`；
- 付款播报只含订单号、商品、金额与时间，不含买家地址/手机号；
- 不建议直接把店主主账号密码交给机器人，请创建权限全开但仅限机器人使用的子账号。

## 数据来源与兼容说明

- 微店：`https://thor.weidian.com/detail/getItemSkuInfo/1.0`（按 SKU 销量 × 价格统计）
- 摩点：`https://zhongchou.modian.com/realtime/get_simple_product`（支持 JSONP）
- OWHAT：`https://appo4.owhat.cn/api`（`findPricesAndStock`）
- 桃叭：`https://www.taoba.club/idols/detail`（页面内金额字段；如平台要求登录，请配置 `cookie`）
- 微店订单：`https://thor.weidian.com/tradeview/seller.getOrderListForPC/1.0`
- 微店发货：`https://thor.weidian.com/tradeview/seller.deliverOrder/1.0`

平台的接口和字段可能调整。若抓取失败，可给项目配置 `api` 指向自定义 HTTP 接口（返回 JSON 且包含 `amount`/`backer_money`/`donation` 与 `backer_count`/`people` 等字段即可）。

运行状态保存在 Koishi 工作目录下的 `weidian-monitor-state.json`，重启后不会重复播报已有数据。`ctx.http` 为 Koishi 内置服务，可通过全局代理配置统一设置网络代理。

## 联系作者

- 邮箱：`sxedward@163.com`
- QQ：`827679511`
- GitHub：<https://github.com/sxedward>
- 问题反馈：<https://github.com/sxedward/sxedward-koishi-plugin-weidian-monitor/issues>
- 更新日志：[CHANGELOG.md](./CHANGELOG.md)
