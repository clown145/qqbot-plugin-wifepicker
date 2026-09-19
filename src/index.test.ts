import { describe, expect, it } from 'vitest'
import { createMockSession, runButton, runCommand } from '@qqbot/sdk/testing'
import type { ScopedDB } from '@qqbot/sdk'
import plugin from './index.js'
import type { ActiveUserRow, CooldownRow, RbqRankingRow, WifeRecordRow } from './types.js'
import { getBeijingDateString } from './utils.js'

function createMemoryDB(): ScopedDB {
  const activeUsers = new Map<string, ActiveUserRow>()
  const records: WifeRecordRow[] = []
  const cooldowns = new Map<string, CooldownRow>()
  let recordAutoId = 1

  return {
    table: (n) => `p_wifepicker_${n}`,
    exec: async () => {},
    run: async (sql, ...params) => {
      // 1. active_users 插入/更新
      if (sql.includes('{active_users}') && sql.includes('INSERT')) {
        const [groupId, userId, username, lastSeen] = params as [string, string, string, number]
        activeUsers.set(`${groupId}:${userId}`, {
          group_id: groupId,
          user_id: userId,
          username,
          last_seen: lastSeen,
        })
        return { changes: 1 }
      }

      // 2. records 插入
      if (sql.includes('INSERT INTO {records}')) {
        const [groupId, userId, wifeId, wifeName, recordType, date, createdAt] = params as [
          string,
          string,
          string,
          string,
          any,
          string,
          number,
        ]
        records.push({
          id: recordAutoId++,
          group_id: groupId,
          user_id: userId,
          wife_id: wifeId,
          wife_name: wifeName,
          record_type: recordType,
          date,
          created_at: createdAt,
        })
        return { changes: 1 }
      }

      // 3. records 更新 (强娶替换)
      if (sql.includes('UPDATE {records}')) {
        const [wifeId, wifeName, createdAt, id] = params as [string, string, number, number]
        const rec = records.find((r) => r.id === id)
        if (rec) {
          rec.wife_id = wifeId
          rec.wife_name = wifeName
          rec.record_type = 'force'
          rec.created_at = createdAt
          return { changes: 1 }
        }
        return { changes: 0 }
      }

      // 4. records 删除指定 ID
      if (sql.includes('DELETE FROM {records} WHERE id = ?')) {
        const [id] = params as [number]
        const idx = records.findIndex((r) => r.id === id)
        if (idx >= 0) {
          records.splice(idx, 1)
          return { changes: 1 }
        }
        return { changes: 0 }
      }

      // 5. cooldowns 设置
      if (sql.includes('{cooldowns}') && sql.includes('INSERT')) {
        const [groupId, userId, cdType, expireAt] = params as [string, string, any, number]
        cooldowns.set(`${groupId}:${userId}:${cdType}`, {
          group_id: groupId,
          user_id: userId,
          cd_type: cdType,
          expire_at: expireAt,
        })
        return { changes: 1 }
      }

      // 6. cooldowns 删除
      if (sql.includes('DELETE FROM {cooldowns}')) {
        let count = 0
        const [groupId, type] = params as [string, string | undefined]
        for (const [key, cd] of cooldowns.entries()) {
          if (cd.group_id === groupId && (!type || cd.cd_type === type)) {
            cooldowns.delete(key)
            count++
          }
        }
        return { changes: count }
      }

      // 7. records 重置今日记录
      if (sql.includes('DELETE FROM {records} WHERE group_id = ? AND date = ?')) {
        const [groupId, date] = params as [string, string]
        let count = 0
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i]!.group_id === groupId && records[i]!.date === date) {
            records.splice(i, 1)
            count++
          }
        }
        return { changes: count }
      }

      // 8. 惰性清理语句：直接返回 0
      if (sql.includes('DELETE FROM {records} WHERE') || sql.includes('DELETE FROM {active_users} WHERE')) {
        return { changes: 0 }
      }

      return { changes: 0 }
    },

    all: async <T>(sql: string, ...params: unknown[]) => {
      // 1. active_users 随机查询
      if (sql.includes('FROM {active_users}')) {
        const [groupId, activeLimitTs] = params as [string, number]
        const list: ActiveUserRow[] = []
        for (const u of activeUsers.values()) {
          if (u.group_id === groupId && u.last_seen >= activeLimitTs) {
            list.push(u)
          }
        }
        return list as T[]
      }

      // 2. records 今日查询
      if (sql.includes('FROM {records} WHERE group_id = ? AND user_id = ? AND date = ?')) {
        const [groupId, userId, date] = params as [string, string, string]
        return records.filter((r) => r.group_id === groupId && r.user_id === userId && r.date === date) as T[]
      }

      // 3. rbq 统计
      if (sql.includes('FROM {records}') && sql.includes('record_type = \'force\'')) {
        const [groupId, since] = params as [string, number]
        const counts = new Map<string, { name: string; count: number }>()
        for (const r of records) {
          if (r.group_id === groupId && r.record_type === 'force' && r.created_at >= since) {
            const cur = counts.get(r.wife_id) || { name: r.wife_name, count: 0 }
            cur.count++
            counts.set(r.wife_id, cur)
          }
        }
        const res: RbqRankingRow[] = Array.from(counts.entries())
          .map(([wife_id, v]) => ({ wife_id, wife_name: v.name, count: v.count }))
          .sort((a, b) => b.count - a.count)
        return res as T[]
      }

      return [] as T[]
    },

    first: async <T>(sql: string, ...params: unknown[]) => {
      // 查 cooldown
      if (sql.includes('FROM {cooldowns}')) {
        const [groupId, userId, cdType, now] = params as [string, string, string, number]
        const cd = cooldowns.get(`${groupId}:${userId}:${cdType}`)
        if (cd && cd.expire_at > now) {
          return cd as T
        }
        return null
      }
      return null
    },
  }
}

describe('qqbot-plugin-wifepicker', () => {
  it('帮助指令 /抽老婆帮助 返回指令列表', async () => {
    const session = await runCommand(plugin, '抽老婆帮助')
    expect(session.replies).toHaveLength(1)
    const reply = session.replies[0] as { markdown: { content: string } }
    expect(reply.markdown.content).toContain('今日老婆插件指令大全')
  })

  it('群外调用提示仅限群聊', async () => {
    const session = await runCommand(plugin, '今日老婆', '', {
      session: { scene: 'c2c' },
    })
    expect(session.replies).toEqual(['⚠️ 今日老婆功能仅限群聊中使用哦~'])
  })

  it('活跃池为空时提示活跃群友不足', async () => {
    const db = createMemoryDB()
    const session = await runCommand(plugin, '今日老婆', '', {
      session: { scene: 'group', targetId: 'group-1', userId: 'user-1', userName: '小明' },
      ctx: { db },
    })
    expect(session.replies[0]).toContain('活跃的群友太少了')
  })

  it('有活跃群友时成功抽取老婆，并限制每日次数', async () => {
    const db = createMemoryDB()
    // 模拟活跃成员发言
    await db.run(
      'INSERT INTO {active_users} (group_id, user_id, username, last_seen) VALUES (?, ?, ?, ?);',
      'group-1',
      'user-2',
      '小红',
      Date.now(),
    )

    // 第一次抽取
    const session1 = await runCommand(plugin, '今日老婆', '', {
      session: { scene: 'group', targetId: 'group-1', userId: 'user-1', userName: '小明' },
      ctx: { db, botId: 'bot-123' },
    })

    expect(session1.replies).toHaveLength(1)
    const res1 = session1.replies[0] as { text: string; image: { url: string } }
    expect(res1.text).toContain('你今天的群友老婆是：小红')
    expect(res1.image.url).toBe('https://thirdqq.qlogo.cn/qqapp/bot-123/user-2/640')

    // 第二次抽取（超出每日 1 次限制）
    const session2 = await runCommand(plugin, '今日老婆', '', {
      session: { scene: 'group', targetId: 'group-1', userId: 'user-1', userName: '小明' },
      ctx: { db, botId: 'bot-123' },
    })
    const res2 = session2.replies[0] as { text: string; image: { url: string } }
    expect(res2.text).toContain('你今天已经有老婆了：小红')

    // 查看我的老婆
    const historySession = await runCommand(plugin, '我的老婆', '', {
      session: { scene: 'group', targetId: 'group-1', userId: 'user-1', userName: '小明' },
      ctx: { db, botId: 'bot-123' },
    })
    const histRes = historySession.replies[0] as { text: string; image: { url: string } }
    expect(histRes.text).toContain('【小红】（抽中）')
  })

  it('强娶群友并进入冷却期', async () => {
    const db = createMemoryDB()
    const session = await runCommand(plugin, '强娶', '', {
      session: {
        scene: 'group',
        targetId: 'group-1',
        userId: 'user-1',
        userName: '霸道总裁',
        raw: {
          mentions: [{ id: 'user-2', username: '小白兔' }],
        },
      },
      ctx: { db, botId: 'bot-123' },
    })

    const res = session.replies[0] as { text: string; image: { url: string } }
    expect(res.text).toContain('霸王硬上弓！成功强娶群友【小白兔】')
    expect(res.text).toContain('3 天强娶冷却期')
    expect(res.image.url).toBe('https://thirdqq.qlogo.cn/qqapp/bot-123/user-2/640')

    // CD 期间再次强娶被拦截
    const sessionBlocked = await runCommand(plugin, '强娶', '', {
      session: {
        scene: 'group',
        targetId: 'group-1',
        userId: 'user-1',
        raw: {
          mentions: [{ id: 'user-3', username: '另一人' }],
        },
      },
      ctx: { db, botId: 'bot-123' },
    })
    expect(sessionBlocked.replies[0]).toContain('强娶还在冷却中')
  })

  it('分手流程与冷静期', async () => {
    const db = createMemoryDB()
    const today = getBeijingDateString()
    // 注入一条抽取记录
    await db.run(
      'INSERT INTO {records} (group_id, user_id, wife_id, wife_name, record_type, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      'group-1',
      'user-1',
      'user-2',
      '前任',
      'draw',
      today,
      Date.now(),
    )

    const session = await runCommand(plugin, '分手', '', {
      session: { scene: 'group', targetId: 'group-1', userId: 'user-1' },
      ctx: { db },
    })

    expect(session.replies[0]).toContain('已与 【前任】 解除伴侣关系')
    expect(session.replies[0]).toContain('72 小时分手冷静期')

    // 冷静期内无法抽取
    const sessionAfter = await runCommand(plugin, '今日老婆', '', {
      session: { scene: 'group', targetId: 'group-1', userId: 'user-1' },
      ctx: { db },
    })
    expect(sessionAfter.replies[0]).toContain('你正处于分手冷静期中')
  })

  it('rbq排行正常输出 Markdown 统计', async () => {
    const db = createMemoryDB()
    const today = getBeijingDateString()
    // 注入 2 条强娶记录
    await db.run(
      'INSERT INTO {records} (group_id, user_id, wife_id, wife_name, record_type, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      'group-1',
      'user-1',
      'target-1',
      '万人迷',
      'force',
      today,
      Date.now(),
    )
    await db.run(
      'INSERT INTO {records} (group_id, user_id, wife_id, wife_name, record_type, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      'group-1',
      'user-2',
      'target-1',
      '万人迷',
      'force',
      today,
      Date.now(),
    )

    const session = await runCommand(plugin, 'rbq排行', '', {
      session: { scene: 'group', targetId: 'group-1' },
      ctx: { db },
    })

    const reply = session.replies[0] as { markdown: { content: string } }
    expect(reply.markdown.content).toContain('万人迷')
    expect(reply.markdown.content).toContain('`2` 次')
  })

  it('recordActiveUser 支持内存防抖与昵称变更识别', async () => {
    const { clearActiveUserCache, recordActiveUser } = await import('./db.js')
    clearActiveUserCache()

    let writeCount = 0
    const db: ScopedDB = {
      table: (n) => `p_wifepicker_${n}`,
      exec: async () => {},
      run: async () => {
        writeCount++
        return { changes: 1 }
      },
      all: async () => [],
      first: async () => null,
    }

    // 1. 首次发言：写入 D1
    const res1 = await recordActiveUser(db, 'group-1', 'user-1', 'Alice', 60 * 1000)
    expect(res1).toBe(true)
    expect(writeCount).toBe(1)

    // 2. 冷却期内同用户同昵称再次发言：防抖拦截，不写 D1
    const res2 = await recordActiveUser(db, 'group-1', 'user-1', 'Alice', 60 * 1000)
    expect(res2).toBe(false)
    expect(writeCount).toBe(1)

    // 3. 同用户更改昵称发言：立即刷新 D1
    const res3 = await recordActiveUser(db, 'group-1', 'user-1', 'AliceNew', 60 * 1000)
    expect(res3).toBe(true)
    expect(writeCount).toBe(2)

    // 4. 不同群友发言：独立记录
    const res4 = await recordActiveUser(db, 'group-1', 'user-2', 'Bob', 60 * 1000)
    expect(res4).toBe(true)
    expect(writeCount).toBe(3)

    // 5. 清理缓存后再次发言：重新写入 D1
    clearActiveUserCache()
    const res5 = await recordActiveUser(db, 'group-1', 'user-1', 'AliceNew', 60 * 1000)
    expect(res5).toBe(true)
    expect(writeCount).toBe(4)
  })
})

