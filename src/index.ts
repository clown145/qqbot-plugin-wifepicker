import { button, definePlugin, keyboard } from '@qqbot/sdk'
import type { WifePickerConfig } from './types.js'
import {
  addRecord,
  drawCandidates,
  getCooldown,
  getRbqRanking,
  getTodayRecords,
  initSchema,
  lazyCleanup,
  recordActiveUser,
  removeRecordById,
  resetGroupCooldown,
  resetGroupTodayRecords,
  setCooldown,
  upsertForceRecord,
} from './db.js'
import {
  extractTargetUser,
  formatRemainingTime,
  getAvatarUrl,
  getBeijingDateString,
  isGroupAdmin,
  isGroupAllowed,
} from './utils.js'

export default definePlugin<WifePickerConfig>({
  name: 'wifepicker',
  displayName: '今日老婆',
  description: '抽取活跃群友当老婆，支持强娶、挑选、求婚与被强娶排行，D1 存储与自动惰性清理',
  permissions: ['db', 'kv'],

  configSchema: {
    type: 'object',
    properties: {
      daily_limit: { type: 'number', title: '每日抽取次数上限', default: 1 },
      force_marry_cd_days: { type: 'number', title: '强娶冷却天数', default: 3 },
      propose_cd_minutes: { type: 'number', title: '求婚冷却分钟数', default: 60 },
      breakup_cd_hours: { type: 'number', title: '分手冷静期小时数', default: 72 },
      active_user_days: { type: 'number', title: '活跃群友筛选天数', default: 30 },
      pick_candidate_count: { type: 'number', title: '挑选老婆候选人数', default: 3 },
      at_waifu: { type: 'boolean', title: '结果是否额外 @对方', default: false },
      auto_set_other_half: { type: 'boolean', title: '自动互设对方为老婆（双向绑定）', default: false },
      excluded_users: {
        type: 'array',
        title: '抽取排除用户 OpenID 列表',
        items: { type: 'string' },
        default: [],
      },
      force_marry_excluded_users: {
        type: 'array',
        title: '强娶排除用户 OpenID 列表',
        items: { type: 'string' },
        default: [],
      },
      whitelist_groups: {
        type: 'array',
        title: '白名单群列表（为空则不限制）',
        items: { type: 'string' },
        default: [],
      },
      blacklist_groups: {
        type: 'array',
        title: '黑名单群列表',
        items: { type: 'string' },
        default: [],
      },
      active_user_throttle_minutes: {
        type: 'integer',
        title: '活跃成员刷库防抖间隔（分钟）',
        description: '同一群友在此时间内的重复发言不会写入 D1，大幅节省数据库写入配额。默认 60 分钟。',
        default: 60,
        minimum: 1,
        maximum: 1440,
      },
      only_record_at_message: {
        type: 'boolean',
        title: '仅记录 @机器人的消息',
        description: '开启后只记录 @机器人的群友作为活跃成员，忽略普通群聊水群消息，极大节省写入额度。默认关闭。',
        default: false,
      },
    },
    required: ['daily_limit', 'force_marry_cd_days', 'active_user_days'],
  },

  defaultConfig: {
    daily_limit: 1,
    force_marry_cd_days: 3,
    propose_cd_minutes: 60,
    breakup_cd_hours: 72,
    active_user_days: 30,
    pick_candidate_count: 3,
    at_waifu: false,
    auto_set_other_half: false,
    excluded_users: [],
    force_marry_excluded_users: [],
    active_user_throttle_minutes: 60,
    only_record_at_message: false,
    whitelist_groups: [],
    blacklist_groups: [],
  },

  hooks: {
    async onInstall(ctx) {
      await initSchema(ctx.db)
    },
    async onBoot(ctx) {
      await initSchema(ctx.db)
    },
  },

  events: {
    // 监听群消息与 @消息，持续静默维护活跃群友池（防抖写入 D1）
    'qq.group.at_message': async ({ session, ctx }) => {
      if (session.scene === 'group' && session.targetId && session.userId) {
        if (!isGroupAllowed(session.targetId, ctx.config)) return
        const throttleMs = (ctx.config.active_user_throttle_minutes || 60) * 60 * 1000
        ctx.waitUntil(recordActiveUser(ctx.db, session.targetId, session.userId, session.userName || '群友', throttleMs))
      }
    },
    'qq.group.message': async ({ session, ctx }) => {
      if (ctx.config.only_record_at_message) return
      if (session.scene === 'group' && session.targetId && session.userId) {
        if (!isGroupAllowed(session.targetId, ctx.config)) return
        const throttleMs = (ctx.config.active_user_throttle_minutes || 60) * 60 * 1000
        ctx.waitUntil(recordActiveUser(ctx.db, session.targetId, session.userId, session.userName || '群友', throttleMs))
      }
    },
  },

  commands: {
    // 1. 今日老婆
    '今日老婆': {
      aliases: ['抽老婆', 'jrlp', 'dailywife', 'wife'],
      description: '随机抽取一名近期的活跃群友作为今日老婆',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 今日老婆功能仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const groupId = session.targetId
        const userId = session.userId
        const today = getBeijingDateString(session.timestamp)

        // 触发时顺带清理过期数据
        ctx.waitUntil(lazyCleanup(ctx.db, ctx.config.active_user_days))

        // 检查是否处于分手冷静期
        const breakupCd = await getCooldown(ctx.db, groupId, userId, 'breakup')
        if (breakupCd) {
          const remaining = formatRemainingTime(breakupCd.expire_at - Date.now())
          return `💔 你正处于分手冷静期中，剩余冷静时间：${remaining}，暂时不能抽取新老婆哦~`
        }

        const todayRecords = await getTodayRecords(ctx.db, groupId, userId, today)
        const dailyLimit = ctx.config.daily_limit

        // 检查今日抽取上限
        if (todayRecords.length >= dailyLimit) {
          if (dailyLimit === 1) {
            const first = todayRecords[0]!
            const avatar = getAvatarUrl(ctx.botId, first.wife_id)
            return {
              text: `🌸 你今天已经有老婆了：${first.wife_name}，可别太贪心哦~`,
              image: { url: avatar },
            }
          }
          return `⚠️ 你今天的抽老婆次数已用尽（今日已抽 ${todayRecords.length}/${dailyLimit} 次）！发送 /我的老婆 可查看今日老婆列表。`
        }

        // 从活跃池中筛选候选人
        const activeLimitTs = Date.now() - ctx.config.active_user_days * 86400 * 1000
        const excluded = ctx.config.excluded_users || []
        const candidates = await drawCandidates(ctx.db, groupId, userId, activeLimitTs, excluded, 1)

        if (candidates.length === 0) {
          return `😿 本群近 ${ctx.config.active_user_days} 天内活跃的群友太少了，抽不出老婆，多让群友们在群里聊聊天吧~`
        }

        const wife = candidates[0]!
        await addRecord(ctx.db, groupId, userId, wife.user_id, wife.username, 'draw', today)

        // 双向互设为老婆（如果开启配置且对方今天还没有记录）
        if (ctx.config.auto_set_other_half) {
          const wifeTodayRecords = await getTodayRecords(ctx.db, groupId, wife.user_id, today)
          if (wifeTodayRecords.length === 0) {
            await addRecord(ctx.db, groupId, wife.user_id, userId, session.userName || '群友', 'draw', today)
          }
        }

        const remaining = Math.max(0, dailyLimit - todayRecords.length - 1)
        const avatarUrl = getAvatarUrl(ctx.botId, wife.user_id)
        const suffix = remaining > 0 ? ` (今日剩余 ${remaining} 次)` : ''

        return {
          text: `🌸 铛铛铛！你今天的群友老婆是：${wife.username}！${suffix}`,
          image: { url: avatarUrl },
        }
      },
    },

    // 2. 我的老婆
    '我的老婆': {
      aliases: ['抽取历史', 'wdlp', 'mywife'],
      description: '查看今日已抽取的老婆记录',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const today = getBeijingDateString(session.timestamp)
        const records = await getTodayRecords(ctx.db, session.targetId, session.userId, today)

        if (records.length === 0) {
          return '🌸 你今天还没有抽过老婆呢，发送 /今日老婆 试试看吧~'
        }

        const typeLabels: Record<string, string> = {
          draw: '抽中',
          force: '强娶',
          pick: '挑中',
          propose: '求婚结缘',
        }

        const lines = records.map((r, i) => `${i + 1}. 【${r.wife_name}】（${typeLabels[r.record_type] || '缘分'}）`)
        const remaining = Math.max(0, ctx.config.daily_limit - records.length)
        const lastWife = records[records.length - 1]!

        return {
          text: `🌸 你今天的后宫名单如下：\n${lines.join('\n')}\n\n今日剩余抽取次数：${remaining} 次`,
          image: { url: getAvatarUrl(ctx.botId, lastWife.wife_id) },
        }
      },
    },

    // 3. 强娶
    '强娶': {
      aliases: ['qiangqu', 'forcemarry'],
      description: '消耗强娶冷却，强行将群友纳为今日老婆：/强娶 @群友',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const groupId = session.targetId
        const userId = session.userId
        const now = Date.now()

        // 检查自己的求婚 CD
        const selfProposeCd = await getCooldown(ctx.db, groupId, userId, 'propose')
        if (selfProposeCd) {
          return `💍 你正处于求婚冷静期，剩余时间：${formatRemainingTime(selfProposeCd.expire_at - now)}，暂时不能强娶哦~`
        }

        // 检查自己的强娶 CD
        const selfForceCd = await getCooldown(ctx.db, groupId, userId, 'force')
        if (selfForceCd) {
          return `⏳ 强娶还在冷却中！剩余冷静时间：${formatRemainingTime(selfForceCd.expire_at - now)}`
        }

        const target = extractTargetUser(session)
        if (!target) {
          return '⚠️ 请在指令后 @ 你想强娶的群友，例如：/强娶 @小可爱'
        }

        if (target.userId === userId) {
          return '👀 不能强娶你自己哦，自恋也要有个限度（bushi）！'
        }

        if (target.userId === session.botId) {
          return '🤖 本机器人可是智能打工人，不能被强娶哦~'
        }

        const forceExcluded = ctx.config.force_marry_excluded_users || []
        if (forceExcluded.includes(target.userId)) {
          return '🛡️ 该用户处于强娶保护名单中，无法被强娶！'
        }

        // 检查对方的求婚 CD
        const targetProposeCd = await getCooldown(ctx.db, groupId, target.userId, 'propose')
        if (targetProposeCd) {
          return `💍 对方正处于求婚冷静期中，不能被打扰哦~ 剩余时间：${formatRemainingTime(targetProposeCd.expire_at - now)}`
        }

        const today = getBeijingDateString(session.timestamp)
        const cdMs = ctx.config.force_marry_cd_days * 86400 * 1000

        // 设置自己的强娶冷却
        await setCooldown(ctx.db, groupId, userId, 'force', now + cdMs)
        // 记录强娶数据
        await upsertForceRecord(ctx.db, groupId, userId, target.userId, target.username, today, ctx.config.daily_limit)

        // 双向记录
        if (ctx.config.auto_set_other_half) {
          const targetToday = await getTodayRecords(ctx.db, groupId, target.userId, today)
          if (targetToday.length === 0) {
            await addRecord(ctx.db, groupId, target.userId, userId, session.userName || '群友', 'force', today)
          }
        }

        ctx.waitUntil(lazyCleanup(ctx.db, ctx.config.active_user_days))

        return {
          text: `💥 恭喜你霸王硬上弓！成功强娶群友【${target.username}】！\n(你已进入 ${ctx.config.force_marry_cd_days} 天强娶冷却期)`,
          image: { url: getAvatarUrl(ctx.botId, target.userId) },
        }
      },
    },

    // 4. 挑选老婆
    '挑选老婆': {
      aliases: ['txlp', 'pickwife'],
      description: '从随机抽取的 3 位候选人中选择一位成为今日老婆',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const groupId = session.targetId
        const userId = session.userId
        const today = getBeijingDateString(session.timestamp)

        const todayRecords = await getTodayRecords(ctx.db, groupId, userId, today)
        if (todayRecords.length >= ctx.config.daily_limit) {
          return `⚠️ 你今天的抽老婆次数已满（${todayRecords.length}/${ctx.config.daily_limit} 次），不能再挑选了哦~`
        }

        const activeLimitTs = Date.now() - ctx.config.active_user_days * 86400 * 1000
        const count = Math.min(6, Math.max(2, ctx.config.pick_candidate_count || 3))
        const candidates = await drawCandidates(ctx.db, groupId, userId, activeLimitTs, ctx.config.excluded_users || [], count)

        if (candidates.length < 2) {
          return `😿 本群近期活跃人数太少（仅找到 ${candidates.length} 位），无法凑成挑选池，建议直接使用 /今日老婆 抽取！`
        }

        // 将候选列表存入 KV，有效期 60 秒
        const stateKey = `pick:${groupId}:${userId}`
        await ctx.kv.put(
          stateKey,
          JSON.stringify({
            groupId,
            userId,
            candidates: candidates.map((c) => ({ id: c.user_id, name: c.username })),
            createdAt: Date.now(),
          }),
          { ttl: 60 },
        )

        // 构建 Inline Keyboard 按钮
        const candidateButtons = candidates.map((c, index) => [
          button.callback(`💕 选 ${index + 1} 号: ${c.username.slice(0, 8)}`, `pick:${c.user_id}`, {
            id: 'pick_select',
            permission: { type: 0, specify_user_ids: [userId] },
          }),
        ])

        candidateButtons.push([
          button.callback('❌ 放弃本次挑选', 'pick:cancel', {
            id: 'pick_cancel',
            permission: { type: 0, specify_user_ids: [userId] },
          }),
        ])

        const candidateText = candidates.map((c, i) => `${i + 1}. 【${c.username}】`).join('\n')

        return {
          markdown: {
            content: `🌸 **请挑选你心仪的今日老婆（请在 60 秒内点击下方按钮选择）：**\n\n${candidateText}`,
          },
          keyboard: keyboard(candidateButtons),
        }
      },
    },

    // 5. 求婚
    '求婚': {
      aliases: ['qh', 'propose'],
      description: '向指定的群友发起浪漫求婚：/求婚 @群友',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const groupId = session.targetId
        const userId = session.userId
        const now = Date.now()

        const target = extractTargetUser(session)
        if (!target) return '⚠️ 请在指令后 @ 你想求婚的对象，例如：/求婚 @群友'
        if (target.userId === userId) return '💍 不能向自己求婚哦，找个群友结缘吧~'
        if (target.userId === session.botId) return '🤖 机器人一心只搞技术，不能接受求婚哦！'

        // 检查双方求婚 CD
        const selfCd = await getCooldown(ctx.db, groupId, userId, 'propose')
        if (selfCd) return `⏳ 你的求婚冷却中，剩余时间：${formatRemainingTime(selfCd.expire_at - now)}`

        const targetCd = await getCooldown(ctx.db, groupId, target.userId, 'propose')
        if (targetCd) return `⏳ 对方正处于求婚冷却中，剩余时间：${formatRemainingTime(targetCd.expire_at - now)}`

        // 存入 pending 求婚状态，60 秒有效
        const proposeKey = `propose:${groupId}:${target.userId}`
        await ctx.kv.put(
          proposeKey,
          JSON.stringify({
            groupId,
            fromId: userId,
            fromName: session.userName || '群友',
            toId: target.userId,
            toName: target.username,
            createdAt: now,
          }),
          { ttl: 60 },
        )

        const kb = keyboard([
          [
            button.callback('💍 我愿意（接受）', `agree:${userId}`, {
              id: 'propose_btn',
              permission: { type: 0, specify_user_ids: [target.userId] },
            }),
            button.callback('💔 对不起（拒绝）', `reject:${userId}`, {
              id: 'propose_btn',
              permission: { type: 0, specify_user_ids: [target.userId] },
            }),
          ],
        ])

        return {
          markdown: {
            content: `💍 **求婚邀请**\n\n【${session.userName || '群友'}】手捧鲜花，深情地向【${target.username}】发起了求婚！\n\n请在 60 秒内做出你的抉择：`,
          },
          keyboard: kb,
        }
      },
    },

    // 6. 分手
    '分手': {
      aliases: ['fs', 'breakup', '离婚'],
      description: '解除非强娶建立的老婆关系，进入 72 小时冷静期',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const groupId = session.targetId
        const userId = session.userId
        const today = getBeijingDateString(session.timestamp)

        const records = await getTodayRecords(ctx.db, groupId, userId, today)
        const breakable = records.filter((r) => r.record_type !== 'force')

        if (breakable.length === 0) {
          return '💔 你今天没有可以解除的老婆关系（强娶关系牢不可破，无法单方面解除哦~）'
        }

        // 解除关系
        for (const r of breakable) {
          await removeRecordById(ctx.db, r.id)
        }

        // 设置冷静期
        const cdHours = ctx.config.breakup_cd_hours || 72
        await setCooldown(ctx.db, groupId, userId, 'breakup', Date.now() + cdHours * 3600 * 1000)

        const names = breakable.map((b) => `【${b.wife_name}】`).join('、')
        return `💔 你已与 ${names} 解除伴侣关系。进入 ${cdHours} 小时分手冷静期，期间无法再抽取新老婆！`
      },
    },

    // 7. 被强娶排行
    'rbq排行': {
      aliases: ['rbqph', 'wifeleaderboard'],
      description: '查看本群最近 30 天被强娶次数最多的 Top 10 群友',
      async handler({ session, ctx }) {
        if (session.scene !== 'group') return '⚠️ 仅限群聊中使用哦~'
        if (!isGroupAllowed(session.targetId, ctx.config)) return

        const list = await getRbqRanking(ctx.db, session.targetId, 30, 10)
        if (list.length === 0) {
          return '🌸 本群近 30 天内还没有人被强娶过呢，大家都好纯洁呀~'
        }

        const medals = ['🥇', '🥈', '🥉']
        const items = list.map((item, idx) => {
          const medal = medals[idx] || `${idx + 1}.`
          return `${medal} **${item.wife_name}** — 被强娶 \`${item.count}\` 次`
        })

        return {
          markdown: {
            content: `📊 **本群近 30 天被强娶风云榜** 🌸\n\n${items.join('\n')}\n\n> 统计范围：最近 30 天强娶记录`,
          },
        }
      },
    },

    // 8. 重置记录（管理员）
    '重置记录': {
      aliases: ['czjl'],
      description: '管理员重置本群今日所有老婆抽取记录',
      async handler({ session, ctx }) {
        if (!isGroupAdmin(session)) return '⛔ 只有群主或管理员才能重置记录哦！'
        const today = getBeijingDateString(session.timestamp)
        const count = await resetGroupTodayRecords(ctx.db, session.targetId, today)
        return `🧹 已成功重置本群今日的老婆记录（清除了 ${count} 条记录）！`
      },
    },

    // 9. 重置强娶时间（管理员）
    '重置强娶时间': {
      aliases: ['czqqsj'],
      description: '管理员重置本群所有群友的强娶冷却',
      async handler({ session, ctx }) {
        if (!isGroupAdmin(session)) return '⛔ 只有群主或管理员才能执行此操作！'
        const count = await resetGroupCooldown(ctx.db, session.targetId, 'force')
        return `🔄 已重置本群群友的强娶冷却 CD（清除了 ${count} 条冷却记录）！`
      },
    },

    // 10. 重置求婚时间（管理员）
    '重置求婚时间': {
      aliases: ['czqhsj'],
      description: '管理员重置本群所有群友的求婚冷却',
      async handler({ session, ctx }) {
        if (!isGroupAdmin(session)) return '⛔ 只有群主或管理员才能执行此操作！'
        const count = await resetGroupCooldown(ctx.db, session.targetId, 'propose')
        return `🔄 已重置本群群友的求婚冷却 CD（清除了 ${count} 条冷却记录）！`
      },
    },

    // 11. 帮助
    '抽老婆帮助': {
      aliases: ['clpbz', 'wifehelp', '老婆插件帮助'],
      description: '查看抽老婆插件全部指令指南',
      handler() {
        return {
          markdown: {
            content: `🌸 **今日老婆插件指令大全** 🌸

- **/今日老婆**（别名：\`抽老婆\` / \`jrlp\` / \`wife\`）：抽取今天的群友老婆
- **/我的老婆**（别名：\`wdlp\` / \`mywife\`）：查看今天抽到的老婆名单与剩余次数
- **/挑选老婆**（别名：\`txlp\` / \`pickwife\`）：随机抽取候选群友，按钮点选
- **/强娶 @群友**（别名：\`qiangqu\` / \`forcemarry\`）：消耗 CD 霸王硬上弓
- **/求婚 @群友**（别名：\`qh\` / \`propose\`）：发起互动求婚卡片
- **/分手**（别名：\`fs\` / \`breakup\`）：解除非强娶伴侣关系
- **/rbq排行**（别名：\`rbqph\`）：查看近 30 天被强娶次数 Top 10
- **/重置记录** / **/重置强娶时间**（管理员专用）`,
          },
        }
      },
    },
  },

  // 按钮交互回调处理
  buttons: {
    // 挑选老婆：选定
    pick_select: async ({ session, ctx, buttonData }) => {
      const selectedWifeId = buttonData.replace(/^pick:/, '')
      const stateKey = `pick:${session.targetId}:${session.userId}`
      const raw = await ctx.kv.get(stateKey)

      if (!raw) {
        return { text: '⚠️ 该挑选会话已超时失效，请重新发送 /挑选老婆 试试吧~' }
      }

      const state = JSON.parse(raw) as { candidates: Array<{ id: string; name: string }> }
      const matched = state.candidates.find((c) => c.id === selectedWifeId)
      const wifeName = matched?.name || `群友(${selectedWifeId.slice(-4)})`
      const today = getBeijingDateString(session.timestamp)

      await addRecord(ctx.db, session.targetId, session.userId, selectedWifeId, wifeName, 'pick', today)
      await ctx.kv.delete(stateKey)

      return {
        text: `🌸 挑选成功！【${wifeName}】已正式成为你今天的伴侣~`,
        image: { url: getAvatarUrl(ctx.botId, selectedWifeId) },
      }
    },

    // 挑选老婆：取消
    pick_cancel: async ({ session, ctx }) => {
      const stateKey = `pick:${session.targetId}:${session.userId}`
      await ctx.kv.delete(stateKey)
      return '💨 你已放弃本次挑选，好男人志在四方！'
    },

    // 求婚按键响应：同意 / 拒绝
    propose_btn: async ({ session, ctx, buttonData }) => {
      const isAgree = buttonData.startsWith('agree:')
      const fromUserId = buttonData.replace(/^(agree|reject):/, '')
      const stateKey = `propose:${session.targetId}:${session.userId}`
      const raw = await ctx.kv.get(stateKey)

      if (!raw) {
        return { text: '⚠️ 求婚邀请已超时，这份心意随风而逝了...' }
      }

      const state = JSON.parse(raw) as { fromId: string; fromName: string; toName: string }
      await ctx.kv.delete(stateKey)

      if (isAgree) {
        const today = getBeijingDateString(session.timestamp)
        const cdMs = (ctx.config.propose_cd_minutes || 60) * 60 * 1000
        const expireAt = Date.now() + cdMs

        // 双方互相写入结缘记录
        await addRecord(ctx.db, session.targetId, fromUserId, session.userId, state.toName, 'propose', today)
        await addRecord(ctx.db, session.targetId, session.userId, fromUserId, state.fromName, 'propose', today)

        // 双方进入求婚 CD
        await setCooldown(ctx.db, session.targetId, fromUserId, 'propose', expireAt)
        await setCooldown(ctx.db, session.targetId, session.userId, 'propose', expireAt)

        return {
          markdown: {
            content: `🎉 恭喜！【${state.toName}】欣然接受了【${state.fromName}】的求婚！\n\n愿得一人心，白首不相离！双方喜结连理！💐🥂`,
          },
        }
      }

      return `💔【${state.toName}】残忍拒绝了【${state.fromName}】的求婚。\n\n天涯何处无芳草，或者...直接试试 /强娶 吧（笑）！`
    },
  },
})
