type SessionNode = { id: string; parentID?: string | null }
type TreeRow<T> = { session: T; depth: number; prefix: string }

export function sessionTree<T extends SessionNode>(sessions: readonly T[], currentID: string) {
  return treeRows(sessions, currentID, true)
}

export function sessionFamily<T extends SessionNode>(sessions: readonly T[], currentID: string) {
  // 选择器维持传入的兄弟顺序，省略根和第一级连线。
  return treeRows(sessions, currentID, false)
    .slice(1)
    .map(({ session, prefix }) => ({ session, prefix: prefix.slice(3) }))
}

function treeRows<T extends SessionNode>(sessions: readonly T[], currentID: string, sort: boolean): TreeRow<T>[] {
  const byID = new Map(sessions.map((session) => [session.id, session]))
  const current = byID.get(currentID)
  if (!current) return []

  let root: T = current
  const ancestors = new Set<T>()
  while (root.parentID) {
    ancestors.add(root)
    const parent = byID.get(root.parentID)
    if (!parent) break
    if (ancestors.has(parent)) {
      // 环上没有天然的根；统一选环内最小的 ID，从哪个节点进入都得到同一棵树。
      const path = [...ancestors]
      root = path.slice(path.indexOf(parent)).reduce((min, node) => (node.id < min.id ? node : min))
      break
    }
    root = parent
  }

  const children = new Map<string, T[]>()
  for (const node of byID.values()) {
    if (!node.parentID || node === root) continue
    const group = children.get(node.parentID)
    if (group) group.push(node)
    else children.set(node.parentID, [node])
  }

  const rows: TreeRow<T>[] = []
  const stack = [{ session: root, depth: 0, prefix: "", indent: "" }]
  while (stack.length) {
    const { session, depth, prefix, indent } = stack.pop()!
    rows.push({ session, depth, prefix })
    const group = children.get(session.id)
    if (!group) continue
    // 数据层按更新时间返回会话；侧栏用不可变 ID 排序，以免新消息或改名让行跳动。
    if (sort) group.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (let i = group.length - 1; i >= 0; i--) {
      const last = i === group.length - 1
      stack.push({
        session: group[i],
        depth: depth + 1,
        prefix: indent + (last ? "└─ " : "├─ "),
        indent: indent + (last ? "   " : "│  "),
      })
    }
  }
  return rows
}

type SessionSource = {
  get(id: string): SessionNode | undefined
  family(id: string): readonly string[]
  sync(id: string, options: { children: true }): Promise<void>
}

const SYNC_BATCH = 4

export async function syncSessionTree(source: SessionSource, sessionID: string, active: () => boolean) {
  const seen = new Set<string>()
  let id: string | undefined = sessionID
  // 一次同步只获取节点和直属子会话的元数据，并复用路由已完成或进行中的同键请求。
  while (id && active() && !seen.has(id)) {
    seen.add(id)
    await source.sync(id, { children: true }).catch(() => undefined)
    id = source.get(id)?.parentID ?? undefined
  }

  // 每一轮的请求会向家族索引追加下一层。单个分支失败时仍补齐其余分支。
  while (active()) {
    const pending = source.family(sessionID).filter((id) => !seen.has(id))
    if (!pending.length) return
    for (let i = 0; i < pending.length; i += SYNC_BATCH) {
      if (!active()) return
      const batch = pending.slice(i, i + SYNC_BATCH)
      batch.forEach((id) => seen.add(id))
      await Promise.allSettled(batch.map((id) => source.sync(id, { children: true })))
    }
  }
}
