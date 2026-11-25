# koishi-plugin-weidian-monitor

微店 / 摩点 / OWHAT / 桃叭 众筹监控与订单播报插件，适用于 **Koishi v4**。

功能参考 CoolQ 插件 `me.cqp.lyt.modianMonitor`（应援 3.65）：轮询众筹项目数据，金额/人数变化时向指定群播报。与原插件不同，本插件不依赖私有鉴权服务器，也没有免费/收费版限制。

## 安装

将本目录放入 Koishi 工作区的 `plugins/` 下，或执行：

```bash
npm install koishi-plugin-weidian-monitor
```

无需编译（CommonJS）。在 `koishi.yml` 中启用：

```yaml
plugins:
  weidian-monitor:
    admins:
      - 'onebot:10000'          # 管理员的用户 ID
    requestTimeout: 10
    noticeOnStart: false
    loginUrl: 'https://d.weidian.com/'   # 登录页
    loginTimeout: 180            # 等待扫码 / 短信验证码 / 登录结果的秒数
    autoUseLoginCookie: true     # 微店项目自动使用登录得到的 Cookie
    autoSlideCaptcha: true       # 尝试自动通过安全验证（失败会提示改用扫码或手动 Cookie）
    projects:
      - platform: weidian
        id: '123456789'
        name: '某某应援企划'
        channels:
          - 'onebot:987654321'  # 播报群，格式 platform:channelId
        interval: 60
        thanks: '【{project}】+{diff} 元，当前 {amount} 元，{supporters} 人\n{link}'
      - platform: modian
        id: '12345'
        name: '摩点项目'
        channels:
          - 'onebot:987654321'
        interval: 90
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `微店状态`（别名 `微店召唤`） | 查看所有项目的金额、人数、更新时间与链接 |
| `微店查询 <序号>` | 查看指定项目详情 |
| `微店测试` | 立即抓取全部项目（管理员） |
| `微店开启 <序号>` / `微店关闭 <序号>` | 开关某个项目的监控（管理员） |
| `微店感谢 <模板>` | 设置全局播报模板，传空内容恢复项目模板（管理员） |
| `微店登录` | 扫码登录微店并自动提取 Cookie（管理员，建议私聊） |
| `微店密码登录 <账号> <密码>` | 手机号 + 密码登录并自动提取 Cookie（管理员，强烈建议私聊） |
| `微店短信登录 <手机号>` | 向手机发送登录验证码（管理员，强烈建议私聊） |
| `微店验证码 <验证码>` | 提交短信验证码完成登录（管理员） |
| `微店登录取消` | 取消等待中的短信验证码登录（管理员） |
| `微店Cookie [内容]`（别名 `微店登录状态`） | 查看已保存 Cookie、手动设置，传 `clear` 清除（管理员） |
| `微店帮助` | 查看命令列表 |

播报模板变量：`{project}` 项目名、`{name}` 平台返回的项目名、`{amount}` 当前金额、`{diff}` 本次变化金额、`{change}` 新增/减少、`{supporters}` 参与人数、`{link}` 项目链接、`{time}` 时间。

## 微店登录与 Cookie 自动提取

三种登录方式都依赖浏览器服务，先安装并启用它（Koishi 官方 Docker 镜像已自带 Chromium）：

```bash
npm install koishi-plugin-puppeteer
```

```yaml
plugins:
  puppeteer:
  weidian-monitor:
    admins: ['onebot:10000']
    loginUrl: 'https://d.weidian.com/'
    loginTimeout: 180
    cookieDomains: ['weidian.com']
    autoUseLoginCookie: true
    autoSlideCaptcha: true
```

### 方式一：扫码登录

管理员私聊发送 `微店登录`：

1. 插件用 Puppeteer 打开微店登录页，点击二维码图标切到扫码视图，并把二维码截图发回会话；
2. 用微信或微店 App 扫码并在手机上确认；
3. 插件每 3 秒检查一次登录状态，检测到登录成功后自动提取 `weidian.com` 域名下的全部 Cookie，拼成 `Cookie` 请求头保存到状态文件。

### 方式二：密码登录

管理员私聊发送（账号为绑定手机号）：

```
微店密码登录 13800138000 yourpassword
```

插件会切换到「密码登录」标签，填入手机号和密码、自动勾选服务协议、点击「进入微店」，等待登录成功后保存 Cookie。密码只用于浏览器表单填写，不会回显或写入状态文件；**请务必私聊发送**，避免聊天记录泄露。

### 方式三：短信验证码登录

分两步完成，验证码不会出现在命令历史之外的位置：

1. 管理员私聊发送 `微店短信登录 13800138000`，插件切到「验证码登录」标签、填写手机号并点击「获取验证码」；
2. 收到短信后发送 `微店验证码 123456`，插件填入验证码、登录并保存 Cookie。

等待时效由 `loginTimeout` 控制，超时后页面自动关闭；可发送 `微店登录取消` 提前放弃，重新发送 `微店短信登录` 也会覆盖旧的等待状态。

### 通用说明与排障

- 登录状态通过 Cookie 中的 uid/token 等字段及页面「退出登录」「我的小店」等标识判断；成功后所有微店项目抓取自动带上该 Cookie，不必在每个项目重复填写 `cookie`。
- 微店部分登录场景会弹出腾讯滑块安全验证：`autoSlideCaptcha: true` 时会尝试自动滑动；若未通过，插件会把验证页面截图发回会话并提示改用扫码登录或手动 Cookie。
- 页面改版导致元素找不到时，可通过 `phoneSelector`、`passwordSelector`、`smsCodeSelector`、`qrSelector` 调整（均为 CSS 选择器，逗号分隔按优先级尝试）；`loginUrl`、`cookieDomains` 也可按需覆盖。
- `微店Cookie` 不带参数查看当前状态及登录来源，`微店Cookie clear` 清除。项目自身配置的 `cookie` 优先级高于登录保存的全局 Cookie；把 `autoUseLoginCookie` 设为 `false` 可关闭自动套用。
- Cookie 以明文保存在 `weidian-monitor-state.json`，请控制该文件访问权限，不要泄露给他人。

## 数据来源与兼容说明

- 微店：`https://thor.weidian.com/detail/getItemSkuInfo/1.0`（按 SKU 销量 × 价格统计）
- 摩点：`https://zhongchou.modian.com/realtime/get_simple_product`（支持 JSONP）
- OWHAT：`https://appo4.owhat.cn/api`（`findPricesAndStock`）
- 桃叭：`https://www.taoba.club/idols/detail`（页面内金额字段；如平台要求登录，请配置 `cookie`）

平台的接口和字段可能调整。若抓取失败，可给项目配置 `api` 指向自定义 HTTP 接口（返回 JSON 且包含 `amount`/`backer_money`/`donation` 与 `backer_count`/`people` 等字段即可）。

运行状态保存在 Koishi 工作目录下的 `weidian-monitor-state.json`，重启后不会重复播报已有数据。`ctx.http` 为 Koishi 内置服务，可通过全局代理配置统一设置网络代理。
