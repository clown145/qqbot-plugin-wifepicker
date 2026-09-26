export interface WifePickerConfig {
  /** 每日抽取次数上限，默认 1 */
  daily_limit: number
  /** 强娶冷却天数，默认 3 */
  force_marry_cd_days: number
  /** 求婚成功后双方冷却分钟数，默认 60 */
  propose_cd_minutes: number
  /** 分手后冷却小时数，默认 72 */
  breakup_cd_hours: number
  /** 活跃成员筛选天数，默认 30 */
  active_user_days: number
  /** 挑选老婆的候选人数，默认 3 */
  pick_candidate_count: number
  /** 抽到老婆或强娶成功时是否在消息末尾艾特对方 */
  at_waifu: boolean
  /** 自动设置对方老婆（双向绑定，对方当天无记录时生效） */
  auto_set_other_half: boolean
  /** 不会被抽中的 openid 列表 */
  excluded_users: string[]
  /** 不能被强娶的 openid 列表 */
  force_marry_excluded_users: string[]
  /** 是否仅记录 @机器人的消息（为 true 时忽略普通群聊消息），默认 false */
  only_record_at_message: boolean
}

/** 活跃群友（旧版 {active_users} 表的一行，也是抽取结果的形状；last_seen 为毫秒） */
export interface ActiveUserRow {
  group_id: string
  user_id: string
  username: string
  last_seen: number
}

export type RecordType = 'draw' | 'force' | 'pick' | 'propose'

export interface WifeRecordRow {
  id: number
  group_id: string
  user_id: string
  wife_id: string
  wife_name: string
  record_type: RecordType
  date: string
  created_at: number
}

export type CooldownType = 'force' | 'propose' | 'breakup'

export interface CooldownRow {
  group_id: string
  user_id: string
  cd_type: CooldownType
  expire_at: number
}

export interface RbqRankingRow {
  wife_id: string
  wife_name: string
  count: number
}

/** 待定状态的种类：pick 按挑选者存，propose 按被求婚者存（都是之后点按钮的那个人） */
export type PendingKind = 'pick' | 'propose'

export interface ProposePendingState {
  groupId: string
  fromId: string
  fromName: string
  toId: string
  toName: string
  createdAt: number
}

export interface PickPendingState {
  groupId: string
  userId: string
  candidates: Array<{ id: string; name: string }>
  createdAt: number
}
