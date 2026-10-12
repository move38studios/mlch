"use client";

import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMulch } from "@/lib/mulch/client";
import { useVoice } from "./Mic";

/**
 * The AI's message to the person (its `tell` tool): an answer, why something
 * could not be done, or a question back. A bubble above the input bar until
 * closed; the newest replaces older ones, which stay in the jobs list. During
 * a call it waits as a dot until opened.
 */
export function Message() {
  const jobs = useMulch((s) => s.jobs);
  const jobAction = useMulch((s) => s.jobAction);
  const inCall = useVoice((s) => !!s.call);
  const open = useMulch((s) => s.messageOpen);
  const job = Object.values(jobs)
    .filter((j) => j.message && !j.message.dismissed)
    .sort((a, b) => b.message!.at - a.message!.at)[0];
  if (!job?.message) return null;
  if (inCall && open !== job.id) {
    return (
      <div className="mb-2.5 flex justify-end pr-3">
        <button onClick={() => useMulch.setState({ messageOpen: job.id })} className="float h-8 px-3 rounded-full text-[12.5px] text-ink-2 hover:text-ink inline-flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-amber" />
          Message
        </button>
      </div>
    );
  }
  return (
    <div className="float mb-2.5 rounded-2xl rounded-br-md px-4 pt-3 pb-3 node-enter" role="status">
      <div className="flex items-start gap-3">
        <p className="flex-1 min-w-0 truncate text-[12px] text-ink-3" title={job.label}>
          {job.label}
        </p>
        <button onClick={() => void jobAction("dismiss-message", { jobId: job.id })} className="-mr-1.5 -mt-1 p-1 rounded-md text-ink-3 hover:bg-paper-2 hover:text-ink" title="Close" aria-label="Close">
          <X size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="mlch-md mt-1 text-[14.5px] leading-[1.5] max-h-[38vh] overflow-auto">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.message.text}</ReactMarkdown>
      </div>
      <div className="mt-2.5 flex justify-end">
        <button onClick={() => void jobAction("keep-message", { jobId: job.id })} className="h-7 px-2.5 rounded-lg text-[12.5px] text-ink-2 hover:bg-paper-2 hover:text-ink">
          Add to canvas
        </button>
      </div>
    </div>
  );
}
