"use client";

import { memo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { useMulch } from "@/lib/mulch/client";
import { useCanvasUi } from "./ui";
import type { MulchGroup } from "@/lib/mulch/types";

export type GroupFlowNode = Node<{ group: MulchGroup }, "mulchGroup">;

function GroupViewImpl({ data, selected }: NodeProps<GroupFlowNode>) {
  const { group } = data;
  const apply = useMulch((s) => s.apply);
  const [editing, setEditing] = useState(false);
  const readOnly = useCanvasUi((s) => s.readOnly);
  const [title, setTitle] = useState(group.title);
  const commit = () => {
    setEditing(false);
    if (title.trim() && title !== group.title) apply([{ op: "updateGroup", id: group.id, patch: { title: title.trim(), userTouched: true } }]);
    else setTitle(group.title);
  };
  return (
    <div className={`w-full h-full rounded-xl border-[1.5px] border-dashed ${selected ? "border-accent/70 bg-accent/[0.03]" : "border-ink/20 bg-ink/[0.015]"}`}>
      <div className="px-4 pt-2.5 text-[13px] font-semibold text-ink-2" onDoubleClick={(e) => { e.stopPropagation(); if (!readOnly) setEditing(true); }}>
        {editing ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" || e.key === "Escape") commit();
            }}
            className="nodrag bg-transparent outline-none border-b border-ink/30 w-full"
          />
        ) : (
          group.title
        )}
      </div>
    </div>
  );
}

export const GroupView = memo(GroupViewImpl);
