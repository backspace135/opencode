import { Plugin } from "@opencode/plugin/tui"
import { displayLabel } from "@opencode/util/session-title-fallback"
import { MouseButton, RGBA } from "@opentui/core"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { useAgentTreeExperiment, useConfig } from "../../config"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { tint } from "../../theme/color"
import { createAnimatable, tween } from "../../ui/animation"
import { ownedJobs, sessionTree, syncSessionTree } from "../../util/session"

export function SidebarAgentTree(props: { context: Plugin.Context; sessionID: string }) {
  const data = useData()
  const client = useClient()
  const theme = props.context.theme
  const rows = createMemo(() => sessionTree(data.session.list(), props.sessionID))
  const root = createMemo(() => data.session.root(props.sessionID))
  const jobs = createMemo(() => data.job.list(root()))
  const config = useConfig().data
  const enabled = () => config.animations ?? true
  const arrivals = new Set<string>()
  // 只强调实时创建的子节点；历史会话补齐、切换分支时不重播整棵树。
  onCleanup(
    client.event.on("session.created", ({ data }) => {
      if (enabled() && data.parentID && rows().some((row) => row.session.id === data.parentID))
        arrivals.add(data.sessionID)
    }),
  )

  // 从孙节点直接进入时，补齐祖先后才知道应读取哪个根的后台任务。
  createEffect(on(root, (id) => void data.job.sync(id).catch(() => undefined)))

  // 断线时停止旧遍历；重连后补齐离线期间可能已结束、不会出现在活动会话快照中的后代。
  createEffect(
    on([() => props.sessionID, client.connection.status], ([id, status]) => {
      if (status !== "connected") return
      let active = true
      onCleanup(() => {
        active = false
      })
      void syncSessionTree(data.session, id, () => active).catch(() => undefined)
    }),
  )

  return (
    <Show when={rows().length > 1}>
      <box flexShrink={0} minWidth={0}>
        <text fg={theme.text.base}>
          <b>Agent tree</b>
        </text>
        <For each={rows().map((row) => row.session.id)}>
          {(id, index) => {
            // 元数据同步会重建遍历结果；按会话 ID 复用行，避免滚动或点击时替换鼠标目标。
            const row = () => rows()[index()]
            const current = () => id === props.sessionID
            const arriving = arrivals.delete(id)
            // 会话切换会重建侧栏；只有选中行或刚出现的子节点需要订阅动画时钟。
            const motion =
              enabled() && (current() || arriving)
                ? createAnimatable(
                    { progress: 0 },
                    { enabled, transition: tween({ duration: 0.12, ease: (t) => 1 - (1 - t) ** 3 }) },
                  )
                : undefined
            motion?.animate({ progress: 1 })
            const progress = () => motion?.value().progress ?? 1
            const background = () => {
              if (!current()) return undefined
              const surface = theme.background.raised.base
              const selected = theme.background.action.primary.selected
              const color =
                selected.a === 0 || selected.equals(surface) ? tint(surface, theme.text.base, 0.12) : selected
              return progress() === 1 ? color : RGBA.fromValues(color.r, color.g, color.b, color.a * progress())
            }
            const foreground = () => {
              const color = current() ? theme.text.action.primary.selected : theme.text.base
              return progress() === 1 ? color : tint(current() ? theme.text.base : theme.text.muted, color, progress())
            }
            const running = () =>
              data.session.status(id) === "running" ||
              ownedJobs(jobs(), id, (id) => data.session.get(id)?.parentID).length > 0
            return (
              <box
                id={`agent-tree-row-${id}`}
                flexDirection="row"
                height={1}
                minWidth={0}
                backgroundColor={background()}
                onMouseUp={(event) => {
                  if (event.button !== MouseButton.LEFT) return
                  event.stopPropagation()
                  if (current()) return
                  props.context.ui.router.navigate({ type: "session", sessionID: id })
                }}
              >
                <text
                  fg={foreground()}
                  selectable={false}
                  flexGrow={1}
                  flexShrink={1}
                  minWidth={0}
                  wrapMode="none"
                  truncate
                >
                  {current() ? "› " : "  "}
                  {row().prefix}
                  {displayLabel(row().session)}
                </text>
                <Show when={running()}>
                  <text fg={theme.text.muted} marginLeft={1} flexShrink={0} selectable={false}>
                    Running
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.agent-tree",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        const enabled = useAgentTreeExperiment()
        return (
          <Show when={enabled()}>
            <SidebarAgentTree context={context} sessionID={props.sessionID} />
          </Show>
        )
      },
    })
  },
})
