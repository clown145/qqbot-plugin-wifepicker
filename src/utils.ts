import { qqAvatar, type Session } from '@qqbot/sdk'
import type { WifePickerConfig } from './types.js'

/** 获取北京时间（UTC+8）的当前日期字符串，格式 YYYY-MM-DD */
export function getBeijingDateString(timestamp: number = Date.now()): string {
  // 加上 8 小时偏移取 ISO 字符串
  const beijingTime = new Date(timestamp + 8 * 3600 * 1000)
  return beijingTime.toISOString().slice(0, 10)
}

/** 获取 QQ 官方机器人体系下的用户 640px 头像 CDN 地址（对齐 @qqbot/sdk qqAvatar 规范） */
export function getAvatarUrl(botId: string, openid: string): string {
  return qqAvatar(botId, openid, 640)
}

/** 格式化毫秒数为人类可读的倒计时文本（如 2天5小时30分 / 15分20秒） */
export function formatRemainingTime(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (days > 0) return `${days}天${hours}小时${mins}分`
  if (hours > 0) return `${hours}小时${mins}分`
  if (mins > 0) return `${mins}分${secs}秒`
  return `${secs}秒`
}

/** 检查当前群是否在允许名单内 */
export function isGroupAllowed(groupId: string, config: WifePickerConfig): boolean {
  if (!groupId) return false
  const gid = String(groupId)
  if (config.blacklist_groups && config.blacklist_groups.includes(gid)) {
    return false
  }
  if (config.whitelist_groups && config.whitelist_groups.length > 0) {
    return config.whitelist_groups.includes(gid)
  }
  return true
}

/** 从 session 中提取提及（@）的目标用户 */
export function extractTargetUser(session: Session): { userId: string; username: string } | null {
  const raw = session.raw as Record<string, unknown> | undefined
  const botId = session.botId

  // 1. 优先从 raw.mentions 数组中提取
  if (Array.isArray(raw?.mentions)) {
    for (const m of raw.mentions) {
      if (m && typeof m === 'object') {
        const id = String((m as { id?: string }).id ?? '').trim()
        const isBot = Boolean((m as { bot?: boolean }).bot)
        if (id && id !== botId && !isBot) {
          const name = String((m as { username?: string }).username ?? '').trim()
          return { userId: id, username: name || `群友(${id.slice(-4)})` }
        }
      }
    }
  }

  // 2. 从原始 content 正文中正则匹配 <@openid>
  const rawContent = String(raw?.content ?? '')
  const match = /<@!?([0-9A-Fa-f]{16,64})>/.exec(rawContent)
  if (match && match[1] && match[1] !== botId) {
    return { userId: match[1], username: `群友(${match[1].slice(-4)})` }
  }

  return null
}

/** 检查发言者是否为管理员或群主（优先使用 session.memberRole） */
export function isGroupAdmin(session: Session): boolean {
  if (session.memberRole === 'admin' || session.memberRole === 'owner') return true
  const raw = session.raw as Record<string, unknown> | undefined
  const author = raw?.author as Record<string, unknown> | undefined
  const role = String(author?.member_role ?? '').toLowerCase()
  return role === 'admin' || role === 'owner'
}
