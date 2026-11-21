import { Plugin } from "@opencode/plugin/tui"
import { displayLabel } from "@opencode/util/session-title-fallback"
import { MouseButton } from "@opentui/core"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { useAgentTreeExperiment } from "../../config"
import { useData } from "../../context/data"
import { ownedJobs, sessionTree, syncSessionTree } from "../../util/session"

export function SidebarAgentTree(props: { context: Plugin.Context; sessionID: string }) {
  const data = useData()
  const theme = props.context.theme
  const rows = createMemo(() => sessionTree(data.session.list(), props.sessionID))
  const root = createMemo(() => data.session.root(props.sessionID))
  const jobs = createMemo(() => data.job.list(root()))

  // 从孙节点直接进入时，补齐祖先后才知道应读取哪个根的后台任务。
  createEffect(on(root, (id) => void data.job.sync(id).catch(() => undefined)))

  // 只同步树的元数据。切换会话、关闭侧栏或实验后，不再继续遍历旧树。
  createEffect(
    on(
      () => props.sessionID,
      (id) => {
        let active = true
        onCleanup(() => {
          active = false
        })
        void syncSessionTree(data.session, id, () => active).catch(() => undefined)
      },
    ),
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
            const running = () =>
              data.session.status(id) === "running" ||
              ownedJobs(jobs(), id, (id) => data.session.get(id)?.parentID).length > 0
            return (
              <box
                id={`agent-tree-row-${id}`}
                flexDirection="row"
                height={1}
                minWidth={0}
                backgroundColor={current() ? theme.background.action.primary.selected : undefined}
                onMouseUp={(event) => {
                  if (event.button !== MouseButton.LEFT) return
                  event.stopPropagation()
                  if (current()) return
                  props.context.ui.router.navigate({ type: "session", sessionID: id })
                }}
              >
                <text
                  fg={current() ? theme.text.action.primary.selected : theme.text.base}
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
