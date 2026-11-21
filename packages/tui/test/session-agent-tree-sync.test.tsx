import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { session } from "./fixture/local"
import { json, type FetchHandler } from "./fixture/tui-client"

function fixture(override: FetchHandler) {
  const nodes = [
    { ...session("ses_root"), title: "Root" },
    { ...session("ses_a"), parentID: "ses_root", title: "Branch A" },
    { ...session("ses_leaf"), parentID: "ses_a", title: "Original leaf" },
    { ...session("ses_b"), parentID: "ses_root", title: "Branch B" },
    { ...session("ses_b1"), parentID: "ses_b", title: "Existing cousin" },
  ]
  const reads: string[] = []
  const app = createAppFixture({
    width: 150,
    height: 36,
    config: { animations: false, tabs: { mode: "off" }, experimental: { "agent-tree": true } },
    args: { sessionID: "ses_leaf" },
    async fetch(url, request) {
      const response = await override(url, request)
      if (response) return response
      if (url.pathname === "/api/session")
        return json({ data: nodes.filter((node) => node.parentID === url.searchParams.get("parentID")), cursor: {} })
      if (url.pathname === "/api/session/active") return json({ data: {} })
      const id = url.pathname.split("/")[3]
      if (!id || !url.pathname.startsWith("/api/session/")) return
      if (url.pathname.endsWith("/message")) {
        reads.push(id)
        return json({ data: [{ type: "user", id: `msg_${id}`, text: id, time: { created: 1 } }], cursor: {} })
      }
      if (url.pathname.endsWith("/inbox")) return json({ data: [] })
      if (url.pathname.endsWith("/view")) return new Response(null, { status: 204 })
      if (url.pathname === `/api/session/${id}`) return json({ data: nodes.find((node) => node.id === id) })
    },
  })
  return { app, nodes, reads }
}

test("冷启动时迟到的父会话列表不会覆盖已经显示的新标题", async () => {
  const requested = Promise.withResolvers<void>()
  const listing = Promise.withResolvers<Response>()
  const setup = fixture((url) => {
    if (url.pathname !== "/api/session" || url.searchParams.get("parentID") !== "ses_a") return
    requested.resolve()
    return listing.promise
  })
  await using app = await setup.app
  await app.ready
  await requested.promise
  const leaf = setup.nodes.find((node) => node.id === "ses_leaf")!
  const stale = json({ data: [leaf], cursor: {} })
  leaf.title = "Renamed leaf"
  try {
    app.events.emit({
      type: "session.renamed",
      id: "evt_rename_leaf",
      created: 2,
      durable: { aggregateID: leaf.id, seq: 1, version: 1 },
      data: { sessionID: leaf.id, title: leaf.title },
    })
    await app.waitForFrame((frame) => frame.includes(leaf.title))
  } finally {
    listing.resolve(stale)
  }
  // 只有合入 A 的旧列表后，遍历才会走到 B 的子节点。
  const frame = await app.waitForFrame((frame) => frame.includes("Existing cousin"))
  expect(frame).toContain("Renamed leaf")
  expect(frame).not.toContain("Original leaf")
})

test("重连补齐断线期间创建并已结束的旁支后代，保留当前会话", async () => {
  const reconnect = Promise.withResolvers<void>()
  let connections = 0
  const setup = fixture((url) => {
    if (url.pathname === "/api/event" && ++connections === 2) reconnect.resolve()
  })
  await using app = await setup.app
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Existing cousin"))
  app.events.disconnect()
  setup.nodes.push({ ...session("ses_missed"), parentID: "ses_b", title: "Offline cousin" })
  await reconnect.promise
  const frame = await app.waitForFrame((frame) => frame.includes("Offline cousin"))
  expect(frame).toMatch(/›[^\n]*Original leaf/)
  expect(new Set(setup.reads)).toEqual(new Set(["ses_leaf"]))
})
