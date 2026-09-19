import type { ScopedDB } from '@qqbot/sdk'
import type { ActiveUserRow, CooldownRow, CooldownType, RbqRankingRow, RecordType, WifeRecordRow } from './types.js'

/** 初始化插件所需的 D1 数据表 */
export async function initSchema(db: ScopedDB): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS {active_users} (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS {records} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      wife_id TEXT NOT NULL,
      wife_name TEXT NOT NULL,
      record_type TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS {cooldowns} (
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cd_type TEXT NOT NULL,
      expire_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id, cd_type)
    );

    CREATE INDEX IF NOT EXISTS {idx_records_group_user_date} ON {records}(group_id, user_id, date);
    CREATE INDEX IF NOT EXISTS {idx_records_created} ON {records}(created_at);
    CREATE INDEX IF NOT EXISTS {idx_active_seen} ON {active_users}(group_id, last_seen);
  `)
}

// 内存防抖缓存：groupId:userId -> { lastSeen: number, username: string }
const activeCache = new Map<string, { lastSeen: number; username: string }>()
const MAX_CACHE_SIZE = 5000

/** 清空活跃成员内存防抖缓存（主要供单测调用） */
export function clearActiveUserCache(): void {
  activeCache.clear()
}

let lastCleanupTime = 0
const CLEANUP_THROTTLE_MS = 10 * 60 * 1000 // 惰性清理防抖：10 分钟最多执行一次

/** 重置惰性清理防抖时间戳（供单测使用） */
export function resetCleanupThrottle(): void {
  lastCleanupTime = 0
}

/** 惰性清理过期数据（在指令触发时顺带执行，避免全表膨胀；内置 10 分钟防抖，避免高频并发重复清理） */
export async function lazyCleanup(db: ScopedDB, activeDays: number): Promise<void> {
  const now = Date.now()
  if (now - lastCleanupTime < CLEANUP_THROTTLE_MS) return
  lastCleanupTime = now

  const oneDayAgo = now - 86400 * 1000
  const activeLimit = now - activeDays * 86400 * 1000
  const thirtyDaysAgo = now - 30 * 86400 * 1000

  // 1. 清理非强娶且超过 24 小时的普通抽取记录
  await db.run('DELETE FROM {records} WHERE record_type != "force" AND created_at < ?', oneDayAgo)
  // 2. 清理超过 30 天的强娶记录（30 天内需保留供 rbq 统计）
  await db.run('DELETE FROM {records} WHERE record_type = "force" AND created_at < ?', thirtyDaysAgo)
  // 3. 清理已到期的 CD 记录
  await db.run('DELETE FROM {cooldowns} WHERE expire_at < ?', now)
  // 4. 清理超过 active_user_days 未发言的不活跃成员
  await db.run('DELETE FROM {active_users} WHERE last_seen < ?', activeLimit)
}

/**
 * 更新/记录群成员活跃状态与最新昵称。
 * 支持内存防抖：同一群友在 throttleMs（默认 60 分钟）内的重复发言且昵称未改变时，直接跳过 D1 写入，极大节省写入额度。
 * @returns 是否实际触发了 D1 写入
 */
export async function recordActiveUser(
  db: ScopedDB,
  groupId: string,
  userId: string,
  username: string,
  throttleMs: number = 60 * 60 * 1000,
): Promise<boolean> {
  const now = Date.now()
  const key = `${groupId}:${userId}`
  const cached = activeCache.get(key)

  // 命中防抖：冷却期内且昵称无变化，跳过 D1 写入
  if (cached && now - cached.lastSeen < throttleMs && cached.username === username) {
    return false
  }

  // 缓存容量保护，超出时淘汰最早加入的条目
  if (activeCache.size >= MAX_CACHE_SIZE) {
    const firstKey = activeCache.keys().next().value
    if (firstKey) activeCache.delete(firstKey)
  }

  activeCache.set(key, { lastSeen: now, username })

  await db.run(
    `INSERT OR REPLACE INTO {active_users} (group_id, user_id, username, last_seen)
     VALUES (?, ?, ?, ?);`,
    groupId,
    userId,
    username,
    now,
  )
  return true
}

/** 获取用户今日的老婆记录 */
export async function getTodayRecords(
  db: ScopedDB,
  groupId: string,
  userId: string,
  date: string,
): Promise<WifeRecordRow[]> {
  return db.all<WifeRecordRow>(
    'SELECT * FROM {records} WHERE group_id = ? AND user_id = ? AND date = ? ORDER BY created_at ASC;',
    groupId,
    userId,
    date,
  )
}

/** 从活跃池中随机抽取候选人 */
export async function drawCandidates(
  db: ScopedDB,
  groupId: string,
  userId: string,
  activeLimitTs: number,
  excludedIds: string[],
  count: number = 1,
): Promise<ActiveUserRow[]> {
  // 过滤掉当前用户与黑名单
  const allExcluded = new Set([...excludedIds, userId, '0'])
  const rows = await db.all<ActiveUserRow>(
    'SELECT * FROM {active_users} WHERE group_id = ? AND last_seen >= ? ORDER BY RANDOM() LIMIT ?;',
    groupId,
    activeLimitTs,
    count * 5, // 多取一些在内存中准确过滤
  )

  const candidates: ActiveUserRow[] = []
  for (const row of rows) {
    if (!allExcluded.has(row.user_id)) {
      candidates.push(row)
      if (candidates.length >= count) break
    }
  }

  return candidates
}

/** 添加一条今日抽取/强娶/挑选记录 */
export async function addRecord(
  db: ScopedDB,
  groupId: string,
  userId: string,
  wifeId: string,
  wifeName: string,
  recordType: RecordType,
  date: string,
): Promise<void> {
  const now = Date.now()
  await db.run(
    `INSERT INTO {records} (group_id, user_id, wife_id, wife_name, record_type, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    groupId,
    userId,
    wifeId,
    wifeName,
    recordType,
    date,
    now,
  )
}

/** 强娶时更新记录：如果当天已有记录且达到上限，替换最早的一条 */
export async function upsertForceRecord(
  db: ScopedDB,
  groupId: string,
  userId: string,
  wifeId: string,
  wifeName: string,
  date: string,
  dailyLimit: number,
): Promise<void> {
  const todayRecords = await getTodayRecords(db, groupId, userId, date)
  const now = Date.now()

  if (todayRecords.length >= dailyLimit && todayRecords[0]) {
    // 替换最早的一条
    await db.run(
      `UPDATE {records}
       SET wife_id = ?, wife_name = ?, record_type = 'force', created_at = ?
       WHERE id = ?;`,
      wifeId,
      wifeName,
      now,
      todayRecords[0].id,
    )
  } else {
    // 未满直接追加
    await addRecord(db, groupId, userId, wifeId, wifeName, 'force', date)
  }
}

/** 获取用户的指定冷却时间（若未冷却返回 null） */
export async function getCooldown(
  db: ScopedDB,
  groupId: string,
  userId: string,
  type: CooldownType,
): Promise<CooldownRow | null> {
  const now = Date.now()
  return db.first<CooldownRow>(
    'SELECT * FROM {cooldowns} WHERE group_id = ? AND user_id = ? AND cd_type = ? AND expire_at > ?;',
    groupId,
    userId,
    type,
    now,
  )
}

/** 设置冷却时间 */
export async function setCooldown(
  db: ScopedDB,
  groupId: string,
  userId: string,
  type: CooldownType,
  expireAt: number,
): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO {cooldowns} (group_id, user_id, cd_type, expire_at)
     VALUES (?, ?, ?, ?);`,
    groupId,
    userId,
    type,
    expireAt,
  )
}

/** 解除指定记录（分手/离婚）：删除该条抽取记录并设置冷静期 */
export async function removeRecordById(db: ScopedDB, recordId: number): Promise<void> {
  await db.run('DELETE FROM {records} WHERE id = ?;', recordId)
}

/** 重置全群指定 CD */
export async function resetGroupCooldown(db: ScopedDB, groupId: string, type?: CooldownType): Promise<number> {
  if (type) {
    const res = await db.run('DELETE FROM {cooldowns} WHERE group_id = ? AND cd_type = ?;', groupId, type)
    return res.changes
  }
  const res = await db.run('DELETE FROM {cooldowns} WHERE group_id = ?;', groupId)
  return res.changes
}

/** 清空当前群今日所有老婆记录 */
export async function resetGroupTodayRecords(db: ScopedDB, groupId: string, date: string): Promise<number> {
  const res = await db.run('DELETE FROM {records} WHERE group_id = ? AND date = ?;', groupId, date)
  return res.changes
}

/** 获取最近 N 天被强娶次数 Top 榜 */
export async function getRbqRanking(
  db: ScopedDB,
  groupId: string,
  days: number = 30,
  limit: number = 10,
): Promise<RbqRankingRow[]> {
  const since = Date.now() - days * 86400 * 1000
  return db.all<RbqRankingRow>(
    `SELECT wife_id, wife_name, COUNT(*) as count
     FROM {records}
     WHERE group_id = ? AND record_type = 'force' AND created_at >= ?
     GROUP BY wife_id
     ORDER BY count DESC
     LIMIT ?;`,
    groupId,
    since,
    limit,
  )
}
