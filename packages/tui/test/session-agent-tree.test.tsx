import { expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

function session(id: string, title: string, parentID?: string) {
  return {
    id,
    title,
    parentID,
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  } satisfies SessionInfo
}

const root = session("ses_root", "Main conversation")
const a = session("ses_a", "Research", root.id)
const a1 = session("ses_a1", "Read docs", a.id)
const b = session("ses_b", "Run tests", root.id)
const x = session("ses_x", "Unrelated")
const family = [root, a, a1, b]
type Node = ReturnType<typeof session>
type App = Awaited<ReturnType<typeof createAppFixture>>

function body(id: string) {
  return id.slice(4).toUpperCase() + "_ONLY"
}

function messages(id: string) {
  return json({ data: [{ type: "user", id: `msg_${id}`, text: body(id), time: { created: 1 } }], cursor: {} })
}

async function fixture(
  current: Node,
  options: {
    sessions?: Node[]
    hold?: Promise<Response>
    height?: number
    clock?: ManualClock
    animations?: boolean
  } = {},
) {
  const sessions = options.sessions ?? [...family, x]
  const reads: string[] = []
  const writes: string[] = []
  const setup =
    options.clock && (await createTestRenderer({ width: 150, height: 36, clock: options.clock, kittyKeyboard: true }))
  if (setup) await setup.renderer.setupTerminal()
  const app = await createAppFixture({
    setup,
    width: 150,
    height: options.height ?? 36,
    config: {
      animations: options.animations ?? false,
      tabs: { mode: "off" },
      experimental: { "agent-tree": true },
      keybinds: { "session.sidebar.toggle": "ctrl+shift+b", "session.child.first": "ctrl+shift+j" },
    },
    args: { sessionID: current.id },
    fetch(url, request) {
      const path = url.pathname
      if (request.method !== "GET" && /^\/api\/(session|experimental\/job)(\/|$)/.test(path)) {
        if (path.endsWith("/view")) return new Response(null, { status: 204 })
        writes.push(`${request.method} ${path}`)
        return new Response(null, { status: 204 })
      }
      // 让无关根确实进入客户端缓存，避免“不显示 X”的断言在空缓存上误过。
      if (path === "/api/session/active")
        return json({ data: sessions.includes(x) ? { [x.id]: { type: "running" } } : {} })
      if (path === "/api/session") {
        const parent = url.searchParams.get("parentID") ?? undefined
        return json({ data: sessions.filter((item) => item.parentID === parent), cursor: {} })
      }
      const match = path.match(/^\/api\/session\/([^/]+)(?:\/(message|inbox))?$/)
      if (!match) return
      const [, id, resource] = match
      if (resource === "inbox") return json({ data: [] })
      if (resource === "message") {
        reads.push(id)
        return id === a1.id && options.hold ? options.hold : messages(id)
      }
      const item = sessions.find((item) => item.id === id)
      return item ? json({ data: item }) : json({}, { status: 404 })
    },
  })
  return { ...app, reads, writes, sessions }
}

// 只查树标题以下的右侧单元格，避免误点正文、侧栏标题或下方的键盘选择器。
function tree(frame: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes("Agent tree"))
  if (y === -1) return []
  const x = lines[y].indexOf("Agent tree")
  return lines.slice(y + 1).map((line, i) => ({ text: line.slice(x), x, y: y + i + 1 }))
}

function marked(frame: string, title: string) {
  return tree(frame).some((row) => row.text.includes("›") && row.text.includes(title))
}

async function click(app: App, title: string, occurrence = 0, padding = false) {
  const row = tree(app.captureCharFrame()).filter((row) => row.text.includes(title))[occurrence]
  if (!row) throw new Error(`Missing tree row: ${title}\n${app.captureCharFrame()}`)
  app.renderer.clearSelection()
  await app.mockMouse.click(row.x + (padding ? 32 : row.text.indexOf(title)), row.y)
}

async function visible(app: App, current: Node, nodes = family) {
  const frame = await app.waitForFrame((frame) => frame.includes(body(current.id)) && marked(frame, current.title))
  const rows = tree(frame)
  expect(rows.filter((row) => row.text.includes("›"))).toHaveLength(1)
  for (const node of nodes) {
    expect(rows.filter((row) => row.text.includes(node.title))).toHaveLength(1)
    if (node.id !== current.id) expect(frame).not.toContain(body(node.id))
  }
  expect(frame).not.toContain(x.title)
  return frame
}

function durable(aggregateID: string, seq = 1) {
  return { aggregateID, seq, version: 1 as const }
}

function hasPrompt(node: Renderable): boolean {
  return node.visible && (node instanceof TextareaRenderable || node.getChildren().some(hasPrompt))
}

test.each([true, false])("代理树动效 %p：新节点和选中行立即可用，只有目标行颜色过渡", async (animations) => {
  const clock = new ManualClock()
  await using app = await fixture(root, { clock, animations, sessions: [root, a] })
  // 交接发生在第一帧；手动时钟不会替已启动的渲染器自动推进这一帧。
  const drive = setInterval(() => clock.advance(16), 5)
  try {
    await app.ready
  } finally {
    clearInterval(drive)
  }
  app.renderer.pause()
  async function paint(title: string, selected = false) {
    const deadline = Date.now() + 3000
    while (true) {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      if (selected ? marked(frame, title) : tree(frame).some((row) => row.text.includes(title))) break
      if (Date.now() >= deadline) throw new Error(`Missing ${title}\n${frame}`)
      await Bun.sleep(5)
    }
    const row = tree(app.captureCharFrame()).find((row) => row.text.includes(title))!
    return app.captureSpans().lines[row.y].spans.find((span) => span.text.includes(title))!
  }
  await paint(a.title)
  clock.advance(250)
  const idle = await paint(a.title)
  const selected = await paint(root.title, true)
  app.sessions.push(b)
  app.events.emit({
    type: "session.created",
    id: "evt_insert",
    created: 2,
    durable: durable(b.id),
    data: {
      sessionID: b.id,
      parentID: root.id,
      title: b.title,
      location: b.location,
      projectID: b.projectID,
      slug: "new",
      version: "test",
    },
  })
  const start = await paint(b.title)
  expect(start.fg.equals(idle.fg), "新行的起始文字色").toBe(!animations)
  clock.advance(50)
  const middle = await paint(b.title)
  expect(middle.fg.equals(start.fg), "新行的过渡文字色").toBe(!animations)
  expect((await paint(a.title)).fg.equals(idle.fg)).toBe(true)
  await click(app, b.title)
  const first = await paint(b.title, true)
  expect(
    first.bg.equals(selected.bg),
    `选中行的起始底色 ${first.bg.toInts()} / ${selected.bg.toInts()} / ${idle.bg.toInts()}`,
  ).toBe(!animations)
  clock.advance(50)
  expect((await paint(b.title, true)).bg.equals(first.bg), "选中行的过渡底色").toBe(!animations)
  await click(app, a.title)
  await paint(a.title, true)
  expect((await paint(b.title)).fg.equals(idle.fg)).toBe(true)
  clock.advance(200)
  expect((await paint(a.title, true)).bg.equals(selected.bg)).toBe(true)
  expect(app.captureCharFrame()).toContain(body(a.id))
})

test("鼠标从主对话依次进入 A、A1、B，再回到主对话", async () => {
  await using app = await fixture(root)
  await app.ready
  await app.waitForFrame((frame) => marked(frame, root.title) && tree(frame).some((row) => row.text.includes(a1.title)))
  await visible(app, root)
  expect(app.reads).toEqual([root.id])
  app.events.emit({
    type: "session.execution.started",
    id: "evt_start",
    created: 2,
    durable: durable(b.id),
    data: { sessionID: b.id },
  })
  await app.waitForFrame((frame) =>
    tree(frame).some((row) => row.text.includes(b.title) && row.text.includes("Running")),
  )

  for (const node of [a, a1, b, root]) {
    await click(app, node.title, 0, node === b)
    const frame = await visible(app, node)
    expect(tree(frame).find((row) => row.text.includes(b.title))?.text).toContain("Running")
    if (node.parentID) {
      expect(frame).not.toContain("Subagents")
    }
    expect(hasPrompt(app.renderer.root)).toBe(!node.parentID)
    if (node === a1) {
      app.mockInput.pressKey("j", { ctrl: true, shift: true })
      await app.waitForFrame((frame) => frame.includes("Subagents") && marked(frame, a1.title))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => !frame.includes("Subagents") && marked(frame, a1.title))
    }
  }
  const transcript = app.renderer.root.findDescendantById(`msg_${root.id}`)
  expect(transcript).toBeDefined()
  const reads = [...app.reads]
  await click(app, root.title)
  await app.waitForVisualIdle()
  await visible(app, root)
  expect(app.renderer.root.findDescendantById(`msg_${root.id}`)).toBe(transcript)
  expect(app.reads).toEqual(reads)
  expect(app.writes).toEqual([])
})

test("从 A1 冷启动并接收新增、改名和完成事件时，保留所选会话", async () => {
  await using app = await fixture(a1)
  await app.ready
  await app.waitForFrame((frame) => tree(frame).some((row) => row.text.includes(b.title)))
  await visible(app, a1)
  expect(app.reads).toEqual([a1.id])
  app.events.emit({
    type: "session.execution.started",
    id: "evt_start",
    created: 2,
    durable: durable(b.id),
    data: { sessionID: b.id },
  })
  const running = await app.waitForFrame((frame) =>
    tree(frame).some((row) => row.text.includes(b.title) && row.text.includes("Running")),
  )
  expect(marked(running, a1.title)).toBe(true)

  const c = session("ses_c", "New sibling", root.id)
  app.sessions.push(c)
  app.events.emit({
    type: "session.created",
    id: "evt_create",
    created: 3,
    durable: durable(c.id),
    data: {
      sessionID: c.id,
      parentID: root.id,
      title: c.title,
      location: c.location,
      projectID: c.projectID,
      slug: "new",
      version: "test",
    },
  })
  const renamed = { ...b, title: "Tests finished" }
  app.sessions.splice(app.sessions.indexOf(b), 1, renamed)
  app.events.emit({
    type: "session.renamed",
    id: "evt_rename",
    created: 4,
    durable: durable(b.id, 2),
    data: { sessionID: b.id, title: renamed.title },
  })
  app.events.emit({
    type: "session.execution.succeeded",
    id: "evt_done",
    created: 5,
    durable: durable(b.id, 3),
    data: { sessionID: b.id },
  })
  const idle = await app.waitForFrame((frame) => {
    const rows = tree(frame)
    return (
      rows.some((row) => row.text.includes(c.title)) &&
      rows.some((row) => row.text.includes(renamed.title) && !row.text.includes("Running"))
    )
  })
  expect(idle).toContain(body(a1.id))
  expect(marked(idle, a1.title)).toBe(true)
  expect(tree(idle).some((row) => row.text.includes(b.title))).toBe(false)
  const members = [root, a, a1, renamed, c]
  await click(app, renamed.title)
  await visible(app, renamed, members)
  expect(app.writes).toEqual([])
})

test("A1 的消息请求迟到不会覆盖已经点开的 B", async () => {
  const response = Promise.withResolvers<Response>()
  await using app = await fixture(a1, { hold: response.promise })
  try {
    await app.ready
    await app.waitForFrame(
      (frame) =>
        marked(frame, a1.title) && tree(frame).some((row) => row.text.includes(b.title)) && app.reads.includes(a1.id),
    )
    await click(app, b.title)
    await visible(app, b)
  } finally {
    response.resolve(messages(a1.id))
  }
  // 后续事件提供可见的同步点；再点回 A1 验证迟到的正文确实已送达。
  app.events.emit({
    type: "session.execution.started",
    id: "evt_barrier",
    created: 3,
    durable: durable(a.id),
    data: { sessionID: a.id },
  })
  await app.waitForFrame((frame) =>
    tree(frame).some((row) => row.text.includes(a.title) && row.text.includes("Running")),
  )
  await visible(app, b)
  await click(app, a1.title)
  await visible(app, a1)
  expect(app.reads.filter((id) => id === a1.id)).toHaveLength(1)
})

test("只有主对话时侧栏不为代理树留空行", async () => {
  await using app = await fixture(root, { sessions: [{ ...root, cost: 1 }] })
  await app.ready
  const frame = await app.waitForFrame((frame) => frame.includes("$1.00 spent") && frame.includes(body(root.id)))
  expect(frame).not.toContain("Agent tree")
})

test("长中文标题只占一行，滚动侧栏后仍能点中屏外的会话", async () => {
  const extra = Array.from({ length: 28 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0")
    return session(`ses_${n}`, `Worker ${n} ${"中文长标题".repeat(8)}尾标`, root.id)
  })
  // 20 行时没有 Getting started 卡片，但是异步加载的目录页脚仍会把视口缩短一行。
  await using app = await fixture(root, { sessions: [root, ...extra], height: 20 })
  await app.ready
  const frame = await app.waitForFrame(
    (frame) => marked(frame, root.title) && tree(frame).some((row) => row.text.includes("packages/tui:main")),
  )
  const rows = tree(frame).filter((row) => row.text.includes("Worker "))
  expect(rows.length).toBeGreaterThan(1)
  expect(rows[1].y - rows[0].y).toBe(1)
  expect(rows[0].text).toContain("中文")
  expect(frame).not.toContain(extra[0].title)

  const target = extra.find((node) => !frame.includes(node.title.slice(0, 9)))!
  const label = target.title.slice(0, 9)
  expect(frame).not.toContain(label)
  // 标题跟着侧栏滚动离屏；沿用可见时测得的侧栏横坐标。
  const x = rows[0].x
  await app.mockMouse.scroll(x + 3, rows[1].y, "down")
  const scrolled = await app.waitForFrame((frame) => frame.includes(label))
  const y = scrolled.split("\n").findIndex((line) => line.slice(x).includes(label))
  await app.mockMouse.click(x + 6, y)
  const selected = await app.waitForFrame((frame) => frame.includes(body(target.id)))
  expect(selected).not.toContain(body(root.id))
  expect(app.writes).toEqual([])
})

test("窄屏仍可开关侧栏并按行区分同名节点", async () => {
  const twins = [a, b].map((node) => ({ ...node, title: "Same name" }))
  await using app = await fixture(root, { sessions: [root, ...twins] })
  await app.ready
  await app.waitForFrame((frame) => tree(frame).filter((row) => row.text.includes("Same name")).length === 2)
  app.resize(64, 30)
  await app.waitForFrame((frame) => frame.includes(body(root.id)) && !frame.includes("Agent tree"))
  app.mockInput.pressKey("b", { ctrl: true, shift: true })
  await app.waitForFrame((frame) => marked(frame, root.title))
  await click(app, "Same name", 0)
  const first = await app.waitForFrame((frame) => [a, b].some((node) => frame.includes(body(node.id))))
  const firstID = first.includes(body(a.id)) ? a.id : b.id
  expect(tree(first).filter((row) => row.text.includes("Same name"))[0]?.text).toContain("›")
  await click(app, "Same name", 1)
  const secondID = firstID === a.id ? b.id : a.id
  const second = await app.waitForFrame((frame) => frame.includes(body(secondID)))
  expect(second).not.toContain(body(firstID))
  expect(tree(second).filter((row) => row.text.includes("Same name"))[1]?.text).toContain("›")
  app.mockInput.pressKey("b", { ctrl: true, shift: true })
  await app.waitForFrame((frame) => !frame.includes("Agent tree") && frame.includes(body(secondID)))
  expect(app.writes).toEqual([])
})
