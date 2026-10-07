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
    <div className={`w-full h-full rounded-[18px] bg-ink/[0.035] ${selected ? "outline-[2.5px] outline-amber outline-offset-2" : ""}`}>
      <div className="px-5 pt-3 text-[14px] font-semibold tracking-[-0.005em] text-ink" onDoubleClick={(e) => { e.stopPropagation(); if (!readOnly) setEditing(true); }}>
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
