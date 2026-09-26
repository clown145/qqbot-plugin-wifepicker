import type { ScopedDB } from '@qqbot/sdk'
import type {
  ActiveUserRow,
  CooldownRow,
  CooldownType,
  PendingKind,
  RbqRankingRow,
  RecordType,
  WifeRecordRow,
} from './types.js'

/**
 * 初始化插件所需的 D1 数据表。
 *
 * 活跃群友存在 {members}：每个群一行，data 是 `{ openid: [昵称, 最后活跃的北京日序号] }`。
 * 旧版一人一行的 {active_users} 不再建也不再写，升级前留下的数据在第一次读到某个群时并进新表（见 loadGroup）。
 */
export async function initSchema(db: ScopedDB): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS {members} (
      group_id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    ) WITHOUT ROWID;

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

    CREATE TABLE IF NOT EXISTS {pending} (
      kind TEXT NOT NULL,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL,
      expire_at INTEGER NOT NULL,
      PRIMARY KEY (kind, group_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS {idx_records_group_user_date} ON {records}(group_id, user_id, date);
    CREATE INDEX IF NOT EXISTS {idx_records_created} ON {records}(created_at);
  `)
}

// ─── 活跃群友 ───────────────────────────────────────────────────────────────
//
// D1 按改动的行数计费（删除、索引也算），每天 10 万行，全机器人共享。这个插件每条群消息都会看一眼，
// 所以写入次数不能跟着消息数涨：
// - 只记到「天」：同一个人一天最多记一次，说 1 句和说 500 句一样；
// - 先读后写：读的额度是写的 50 倍，记过的人一律不写；
// - 一个群一行：当天新冒出来的人攒在内存里，同一个群最多每 FLUSH_MS 写一次，
//   一条 json_patch 把攒下的人和要剔掉的过期群友一起并进去，只算 1 行。
// isolate 被回收时没写进去的人会丢，他们下次说话就补上，活跃名单本来就是个大概。

/** 同一个群最多多久写一次 */
const FLUSH_MS = 5 * 60 * 1000
/** 内存里的群名单多久以后重新读一次（别的 isolate 写进去的人要能看到） */
const CACHE_MS = 10 * 60 * 1000
const MAX_CACHED_GROUPS = 500

/** openid → [昵称, 最后活跃的北京日序号] */
type MemberMap = Map<string, [string, number]>

interface GroupState {
  members: MemberMap
  loadedAt: number
  /** 还没写进 D1 的新增 / 改名 / 当天首次活跃 */
  pending: MemberMap
  lastFlush: number
  flushing?: Promise<boolean> | undefined
}

const groups = new Map<string, GroupState>()

/** 清空活跃群友的内存缓存（主要供单测调用） */
export function clearActiveUserCache(): void {
  groups.clear()
}

/** 北京时间的日序号：1970-01-01 起第几天 */
export function beijingDay(ms: number = Date.now()): number {
  return Math.floor((ms + 8 * 3600 * 1000) / 86400000)
}

function parseMembers(data: string | undefined): MemberMap {
  const map: MemberMap = new Map()
  if (!data) return map
  try {
    for (const [id, v] of Object.entries(JSON.parse(data) as Record<string, unknown>)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number') map.set(id, [v[0], v[1]])
    }
  } catch {
    // 坏数据当成空名单，下次写入会重新攒起来
  }
  return map
}

/**
 * 读一个群的名单（1 行）。新表里还没有这个群时，从升级前的 {active_users} 捞一次，
 * 捞到的人放进 pending，下次写入就并进新表；旧表不存在（新装的）就当没有
 */
async function readGroup(db: ScopedDB, groupId: string): Promise<{ members: MemberMap; legacy: MemberMap }> {
  const row = await db.first<{ data: string }>('SELECT data FROM {members} WHERE group_id = ?;', groupId)
  if (row) return { members: parseMembers(row.data), legacy: new Map() }
  const legacy: MemberMap = new Map()
  try {
    const rows = await db.all<ActiveUserRow>('SELECT user_id, username, last_seen FROM {active_users} WHERE group_id = ?;', groupId)
    for (const r of rows) legacy.set(r.user_id, [r.username, beijingDay(r.last_seen)])
  } catch (err) {
    if (!String(err).includes('no such table')) throw err
  }
  return { members: new Map(legacy), legacy }
}

async function loadGroup(db: ScopedDB, groupId: string, now: number): Promise<GroupState> {
  let state = groups.get(groupId)
  if (state && now - state.loadedAt < CACHE_MS) return state
  const { members, legacy } = await readGroup(db, groupId)
  if (state) {
    // 重新读到的名单盖掉旧缓存，还没写进去的照样留着
    for (const [id, v] of state.pending) members.set(id, v)
    state.members = members
    state.loadedAt = now
  } else {
    if (groups.size >= MAX_CACHED_GROUPS) {
      const oldest = groups.keys().next().value
      if (oldest !== undefined) groups.delete(oldest)
    }
    state = { members, loadedAt: now, pending: legacy, lastFlush: 0 }
    groups.set(groupId, state)
  }
  return state
}

/**
 * 把攒下的人写进 D1：先重读一次这一行（别的 isolate 可能刚写过），据此算出要剔掉的过期群友，
 * 和新增的人一起放进一条 json_patch——值为 null 的键会被删掉。整条语句只改这一行。
 */
async function flushGroup(db: ScopedDB, groupId: string, state: GroupState, activeDays: number, now: number): Promise<boolean> {
  const batch = new Map(state.pending)
  if (!batch.size) return false
  state.lastFlush = now
  const { members: fresh } = await readGroup(db, groupId)
  const oldest = beijingDay(now) - activeDays
  const patch: Record<string, [string, number] | null> = {}
  for (const [id, [, day]] of fresh) if (day < oldest && !batch.has(id)) patch[id] = null
  // 攒下的也可能早就过期了（从旧表迁过来的）
  for (const [id, v] of batch) patch[id] = v[1] < oldest ? null : v
  await db.run(
    `INSERT INTO {members} (group_id, data) VALUES (?1, json_patch('{}', ?2))
     ON CONFLICT(group_id) DO UPDATE SET data = json_patch({members}.data, ?2);`,
    groupId,
    JSON.stringify(patch),
  )
  // 写的时候又来了新的就留着下次写
  for (const [id, v] of batch) if (state.pending.get(id) === v) state.pending.delete(id)
  for (const [id, v] of fresh) if (!state.pending.has(id)) state.members.set(id, v)
  for (const [id, v] of Object.entries(patch)) {
    if (v === null) state.members.delete(id)
    else state.members.set(id, v)
  }
  state.loadedAt = now
  return true
}

let lastCleanupTime = 0
const CLEANUP_THROTTLE_MS = 10 * 60 * 1000 // 惰性清理防抖：10 分钟最多执行一次

/** 重置惰性清理防抖时间戳（供单测使用） */
export function resetCleanupThrottle(): void {
  lastCleanupTime = 0
}

/** 惰性清理过期数据（在指令触发时顺带执行，避免全表膨胀；内置 10 分钟防抖，避免高频并发重复清理） */
export async function lazyCleanup(db: ScopedDB): Promise<void> {
  const now = Date.now()
  if (now - lastCleanupTime < CLEANUP_THROTTLE_MS) return
  lastCleanupTime = now

  const oneDayAgo = now - 86400 * 1000
  const thirtyDaysAgo = now - 30 * 86400 * 1000

  // 1. 清理非强娶且超过 24 小时的普通抽取记录
  await db.run('DELETE FROM {records} WHERE record_type != "force" AND created_at < ?', oneDayAgo)
  // 2. 清理超过 30 天的强娶记录（30 天内需保留供 rbq 统计）
  await db.run('DELETE FROM {records} WHERE record_type = "force" AND created_at < ?', thirtyDaysAgo)
  // 3. 清理已到期的 CD 记录
  await db.run('DELETE FROM {cooldowns} WHERE expire_at < ?', now)
  // 4. 清理没人点、已过期的挑选/求婚待定状态
  await db.run('DELETE FROM {pending} WHERE expire_at < ?', now)
  // 不活跃的群友在写入名单时顺手剔掉（见 flushGroup），不用单独删
}

/**
 * 存一份按钮交互的待定状态（挑选老婆的候选名单、等对方回应的求婚），同一人同一种只留最新一份。
 * 放 D1 不放 KV：KV 写、删各只有 1,000 次/天且全机器人共享，一轮交互就要写删各一次
 */
export async function savePending(
  db: ScopedDB,
  kind: PendingKind,
  groupId: string,
  userId: string,
  data: unknown,
  ttlMs: number,
): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO {pending} (kind, group_id, user_id, data, expire_at)
     VALUES (?, ?, ?, ?, ?);`,
    kind,
    groupId,
    userId,
    JSON.stringify(data),
    Date.now() + ttlMs,
  )
}

/** 取出并删掉待定状态：一条 DELETE … RETURNING，按钮连点两下也只有一次拿得到；过期或已被取走返回 null */
export async function takePending<T>(db: ScopedDB, kind: PendingKind, groupId: string, userId: string): Promise<T | null> {
  const row = await db.first<{ data: string }>(
    'DELETE FROM {pending} WHERE kind = ? AND group_id = ? AND user_id = ? AND expire_at > ? RETURNING data;',
    kind,
    groupId,
    userId,
    Date.now(),
  )
  return row ? (JSON.parse(row.data) as T) : null
}

/**
 * 记一次群友发言。今天已经记过且昵称没变就什么都不做；否则放进待写队列，
 * 离这个群上次写入满 FLUSH_MS 才真的写（一次写入 1 行，带上期间攒下的所有人）。
 * @param activeDays 超过这么多天没活跃的群友在写入时顺手剔掉
 * @returns 这次是否写了 D1
 */
export async function recordActiveUser(
  db: ScopedDB,
  groupId: string,
  userId: string,
  username: string,
  activeDays: number,
): Promise<boolean> {
  const now = Date.now()
  const today = beijingDay(now)
  const state = await loadGroup(db, groupId, now)
  const known = state.pending.get(userId) ?? state.members.get(userId)
  if (!(known && known[1] === today && known[0] === username)) {
    const entry: [string, number] = [username, today]
    state.pending.set(userId, entry)
    state.members.set(userId, entry)
  }
  if (!state.pending.size || now - state.lastFlush < FLUSH_MS) return false
  // 同一个群同时只写一次；并发进来的消息等它写完再看要不要写
  if (state.flushing) return state.flushing.then(() => false)
  state.flushing = flushGroup(db, groupId, state, activeDays, now).finally(() => {
    state.flushing = undefined
  })
  return state.flushing
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

/**
 * 从活跃池中随机抽取候选人。重新读一次整群名单（1 行）再并上本 isolate 还没写进去的人，
 * 抽到的都是真在名单里的；过期的、自己、黑名单都排除
 */
export async function drawCandidates(
  db: ScopedDB,
  groupId: string,
  userId: string,
  activeDays: number,
  excludedIds: string[],
  count: number = 1,
): Promise<ActiveUserRow[]> {
  const now = Date.now()
  const { members } = await readGroup(db, groupId)
  for (const [id, v] of groups.get(groupId)?.pending ?? []) members.set(id, v)

  const oldest = beijingDay(now) - activeDays
  const allExcluded = new Set([...excludedIds, userId, '0'])
  const pool: ActiveUserRow[] = []
  for (const [id, [username, day]] of members) {
    if (day >= oldest && !allExcluded.has(id)) {
      pool.push({ group_id: groupId, user_id: id, username, last_seen: day * 86400000 - 8 * 3600 * 1000 })
    }
  }
  // 洗牌取前 count 个
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, count)
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
