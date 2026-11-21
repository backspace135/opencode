import type { JobInfo, SessionInfo, SessionMessageInfo } from "@opencode/client"
import { createData } from "@opencode/client/solid"
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { sessionFamily, sessionTree, syncSessionTree, ownedJobs, scriptLabel } from "../../src/util/session"
import { createApi, createFetch, directory, json } from "../fixture/tui-client"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("keeps the same rooted tree when navigation or the input order changes", () => {
    const root = { id: "root" }
    const a = { id: "a", parentID: "root" }
    const leaf = { id: "leaf", parentID: "a" }
    const b = { id: "b", parentID: "root" }
    const sessions = [b, leaf, { id: "other" }, root, a]
    const expected = [
      { session: root, depth: 0, prefix: "" },
      { session: a, depth: 1, prefix: "├─ " },
      { session: leaf, depth: 2, prefix: "│  └─ " },
      { session: b, depth: 1, prefix: "└─ " },
    ]
    expect(sessionTree(sessions, "root")).toEqual(expected)
    expect(sessionTree(sessions.toReversed(), "leaf")).toEqual(expected)
    expect(sessionTree(sessions, "b")).toEqual(expected)
    expect(sessionFamily(sessions, "leaf")).toEqual([
      { session: b, prefix: "" },
      { session: a, prefix: "" },
      { session: leaf, prefix: "└─ " },
    ])
  })

  test("keeps the highest available ancestor until the missing parent arrives", () => {
    const root = { id: "root" }
    const a = { id: "a", parentID: "root" }
    const leaf = { id: "leaf", parentID: "a" }
    expect(sessionTree([], "leaf")).toEqual([])
    expect(sessionTree([root], "leaf")).toEqual([])
    expect(sessionTree([root, leaf], "leaf")).toEqual([{ session: leaf, depth: 0, prefix: "" }])
    expect(sessionTree([leaf, a], "leaf")[0]?.session).toBe(a)
    expect(sessionTree([leaf, a, root], "leaf")[0]?.session).toBe(root)
  })

  test("deduplicates session IDs and cuts cycles, including a self-parent", () => {
    const a = { id: "a", parentID: "b" }
    const b = { id: "b", parentID: "a" }
    const leaf = { id: "leaf", parentID: "b" }
    const sessions = [leaf, a, b, { ...leaf }]
    for (const id of ["leaf", "a", "b"]) {
      expect(sessionTree(sessions, id).map((row) => row.session.id)).toEqual(["a", "b", "leaf"])
    }
    const self = { id: "self", parentID: "self" }
    expect(sessionTree([self, self], "self")).toEqual([{ session: self, depth: 0, prefix: "" }])
  })
})

test("syncs cold ancestors and every descendant with cached metadata-only requests", async () => {
  const parents = new Map<string, string | undefined>([
    ["root", undefined],
    ["a", "root"],
    ["leaf", "a"],
    ["b", "root"],
    ["nested", "b"],
    ["other", undefined],
  ])
  const info = (id: string): SessionInfo => ({
    id,
    parentID: parents.get(id),
    location: { directory },
    projectID: "project",
    time: { created: 0, updated: 0 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const calls: string[] = []
  const api = createApi(
    createFetch((url, request) => {
      const parent = url.searchParams.get("parentID")
      calls.push(`${request.method} ${url.pathname}${parent ? `?parentID=${parent}` : ""}`)
      if (url.pathname === "/api/session" && parent)
        return json({ data: [...parents].filter(([, id]) => id === parent).map(([id]) => info(id)), cursor: {} })
      const id = url.pathname.split("/").at(-1)!
      if (parents.has(id)) return json({ data: info(id) })
      throw new Error(`unexpected request: ${url}`)
    }).fetch,
  )
  const { session, dispose } = createRoot((dispose) => ({
    session: createData({ api: () => api, directory, event: { on: () => () => {}, listen: () => () => {} } }).session,
    dispose,
  }))
  try {
    await session.sync("leaf", { children: true })
    calls.length = 0
    await syncSessionTree(session, "leaf", () => true)
    expect(session.family("leaf").toSorted()).toEqual(["a", "b", "leaf", "nested", "root"])
    expect(calls.toSorted()).toEqual(
      ["a", "b", "nested", "root"]
        .flatMap((id) => [`GET /api/session/${id}`, `GET /api/session?parentID=${id}`])
        .toSorted(),
    )
    calls.length = 0
    await syncSessionTree(session, "b", () => true)
    expect(calls).toEqual([])
  } finally {
    dispose()
  }
})

test("stops scheduling a wide family when the sidebar unmounts", async () => {
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const ids = ["root", ...Array.from({ length: 20 }, (_, i) => String(i))]
  const calls: string[] = []
  let active = true
  const done = syncSessionTree(
    {
      get: (id) => ({ id, parentID: id === "root" ? undefined : "root" }),
      family: () => ids,
      async sync(id) {
        calls.push(id)
        if (id === "root") return
        started.resolve()
        await finish.promise
      },
    },
    "root",
    () => active,
  )
  await started.promise
  active = false
  const pending = calls.length
  finish.resolve()
  await done
  expect(pending).toBeLessThanOrEqual(1 + 4)
  expect(calls).toHaveLength(pending)
})

test("ownedJobs follows a subagent job to its child when the child's parent is not loaded", () => {
  const parents: Record<string, string> = { child: "session" }
  const jobs: JobInfo[] = [
    { kind: "codemode", id: "cm_grandchild", sessionID: "grandchild", status: "running", time: { started: 1 } },
    {
      kind: "subagent",
      id: "sub_nested",
      sessionID: "child",
      childSessionID: "grandchild",
      agent: "general",
      description: "Nested",
      status: "running",
      time: { started: 1 },
    },
  ]
  expect(ownedJobs(jobs, "child", (id) => parents[id]).map((job) => job.id)).toEqual(["sub_nested"])
  expect(ownedJobs(jobs, "session", (id) => parents[id]).map((job) => job.id)).toEqual(["sub_nested"])
  expect(ownedJobs(jobs, "grandchild", (id) => parents[id]).map((job) => job.id)).toEqual([
    "cm_grandchild",
    "sub_nested",
  ])
})

test("scriptLabel names a script by its first line of code, then its title", () => {
  const job: JobInfo = { kind: "codemode", id: "cm_1", sessionID: "session", status: "running", time: { started: 1 } }
  const messages = [
    {
      id: "msg",
      type: "assistant",
      content: [
        {
          type: "tool",
          id: "part",
          name: "execute",
          state: { status: "completed", input: { code: "\n  // Build both\nawait 1" }, metadata: { jobID: "cm_1" } },
        },
      ],
    },
  ] as unknown as SessionMessageInfo[]
  expect(scriptLabel(messages, job)).toBe("// Build both")
  expect(scriptLabel([], { ...job, title: "Build" })).toBe("Build")
  expect(scriptLabel([], job)).toBe("Script")
})
