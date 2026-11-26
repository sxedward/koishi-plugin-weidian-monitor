# 更新日志

## 1.3.0 (2026-11-26)

- npm 包迁移至作用域包 `@sxedward/koishi-plugin-weidian-monitor`，旧包 `koishi-plugin-weidian-monitor` 已标记为弃用。
- GitHub 仓库迁移至 `sxedward/sxedward-koishi-plugin-weidian-monitor`，`homepage` / `repository` / `bugs` 元数据同步更新。
- 在 README、包元数据和新人入门指南中补充作者联系方式：邮箱 `sxedward@163.com`、QQ `827679511`。
- 安装说明改用 `koishi add sxedward/koishi-plugin-weidian-monitor`。

## 1.2.0 (2026-11-26)

- 修复自动发货开关：发货轮询任务改为常驻，每轮都读取运行时开关状态；`微店发货开启` / `微店发货关闭` 可即时生效并在重启后保持。
- `微店发货` 手动执行不受定时开关影响。

## 1.1.0

- 新增微店订单自动发货：支持 `no-logistics` / `ecode` / `express` 三种模式、订单去重、卡密池与演练模式。
- 播报与发货共用一次登录获取的 Cookie；可用权限全开的子账号登录。

## 1.0.0

- 首次发布：微店 / 摩点 / OWHAT / 桃叭 众筹监控与播报。
- 支持扫码登录、密码登录、短信验证码登录及 Cookie 自动提取。
