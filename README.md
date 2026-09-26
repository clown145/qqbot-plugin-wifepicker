# 🌸 今日老婆插件 (qflarebot-plugin-wifepicker)

适用于 [QFlareBot](https://github.com/qflarebot/QFlareBot) 的群聊互动插件。从群内近期活跃成员中随机抽取“今日老婆”，并提供强娶、挑选、求婚及被强娶风云榜等互动功能。

本项目基于 [astrbot-plugin-wifepicker](https://github.com/Heximiao/astrbot-plugin-wifepicker) 进行深度重构与架构移植，针对 Cloudflare Workers Serverless 边缘环境进行了彻底优化。

---

## ✨ 核心亮点

- ⚡ **边缘 D1 数据库存储**：彻底抛弃本地 JSON 文件，使用 Cloudflare D1 边缘 SQLite 存储活跃成员、抽取记录、冷却状态以及挑选/求婚按钮的待定状态，具备天然的原子性与高并发安全性；不占用额度紧张的 KV。
- 🧹 **惰性数据清理**：无须额外的数据库触发器或常驻后台任务，在指令触发时顺带清理 24 小时前普通记录、30 天前过期历史以及到期 CD。
- 🤖 **QQ 官方机器人深度适配**：
  - 完美适配 `member_openid` 匿名体系；
  - 自动从消息提及中识别被 `@` 的群友；
  - 头像原生使用腾讯官方 640px CDN（`https://thirdqq.qlogo.cn/qqapp/{botId}/{openid}/640`）。
- 🔘 **Inline Keyboard 交互升级**：
  - 「挑选老婆」下发候选人按钮，点击即选；
  - 「求婚」下发带 `[💍 我愿意]` 与 `[💔 对不起]` 的卡片，且仅限被求婚者本人点击生效。
- 🚀 **极速轻量**：剥离重型无头浏览器与力导向图 JS 库，构建产物仅 36 KB，冷启动毫秒级响应。

---

## 🎮 指令说明

| 指令 | 英文缩写 / 别名 | 权限 | 说明 |
| :--- | :--- | :--- | :--- |
| `/今日老婆` | `抽老婆`、`jrlp`、`dailywife`、`wife` | 用户 | 随机抽取一名活跃群友作为今日老婆 |
| `/我的老婆` | `抽取历史`、`wdlp`、`mywife` | 用户 | 查看今天抽到的老婆记录及剩余次数 |
| `/强娶 @群友` | `qiangqu`、`forcemarry` | 用户 | 消耗冷却强行纳为今日老婆（默认冷却 3 天） |
| `/挑选老婆` | `txlp` | 用户 | 随机挑选 3 位候选人，生成内嵌按钮点击选择 |
| `/求婚 @群友` | `qh`、`propose` | 用户 | 向指定群友发起求婚，60 秒内等待对方点击同意或拒绝 |
| `/分手` | `fs`、`breakup`、`离婚` | 用户 | 解除非强娶建立的伴侣关系，进入 72 小时冷静期 |
| `/rbq排行` | `rbqph`、`wifeleaderboard` | 用户 | 查看本群近 30 天被强娶次数 Top 10 榜单 |
| `/重置记录` | `czjl` | 管理员 | 清空当前群今日所有老婆记录 |
| `/重置强娶时间` | `czqqsj` | 管理员 | 清空当前群所有群友的强娶冷却 CD |
| `/重置求婚时间` | `czqhsj` | 管理员 | 清空当前群所有群友的求婚冷却 CD |
| `/抽老婆帮助` | `clpbz`、`wifehelp` | 用户 | 查看详细指令说明 |

---

## ⚙️ 可配置项 (可在面板直接配置)

- `daily_limit`：每日抽取上限（默认 1 次）
- `force_marry_cd_days`：强娶冷却天数（默认 3 天）
- `propose_cd_minutes`：求婚成功冷却分钟数（默认 60 分钟）
- `breakup_cd_hours`：分手冷静期小时数（默认 72 小时）
- `active_user_days`：活跃群友筛选天数（默认 30 天）
- `pick_candidate_count`：挑选老婆展示的候选人数（默认 3 人）
- `auto_set_other_half`：双向绑定老婆（对方当天无记录时生效，默认关闭）
- `excluded_users`：抽老婆排除用户列表
- `force_marry_excluded_users`：强娶保护名单

只想在部分群启用：在面板的插件详情页设置「生效的群」（所有群 / 只在这些群 / 除了这些群），由框架在分发时过滤。0.2.0 起去掉了插件自带的 `whitelist_groups` / `blacklist_groups`，升级后请在面板重新设置；需要 QFlareBot 已带「生效的群」的版本（2026-09-26 起）。

---

## 🛠️ 构建与测试

```bash
npm install    # 安装依赖
npm test       # 运行 vitest 单元测试
npm run build  # 构建产物为 dist/plugin.js 并抽取 manifest.json
npm run sync   # 同步清单到根目录供机器人安装使用
```
