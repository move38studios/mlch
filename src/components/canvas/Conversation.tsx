"use client";

import { useEffect, useMemo, useRef } from "react";
import { RotateCcw, Square, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { create } from "zustand";
import { Scribble } from "@/components/brand/Scribble";
import { useMulch } from "@/lib/mulch/client";
import type { JobStatus, TranscriptSegment } from "@/lib/mulch/events";
import { useVoice } from "./Mic";

/**
 * The conversation with a mulch, beside the canvas on the right: what the
 * person said or typed, what became of it (cards, an instruction), the AI's
 * messages, results and failures, and a call's transcript. Closed by default;
 * opens when the AI writes to the person and when a call starts.
 * Wording is placeholder (George).
 */

const STORAGE = "mlch.conversation.open";

export const useConversation = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen(open) {
    set({ open });
    try {
      localStorage.setItem(STORAGE, open ? "1" : "0");
    } catch {}
  },
}));

type Entry =
  | { kind: "said"; at: number; segment: TranscriptSegment; took: JobStatus[] }
  | { kind: "job"; at: number; job: JobStatus };

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Connector tools waiting for the person's answer: the panel opens for them. */
export function waitingApprovals(jobs: Record<string, JobStatus>): Array<{ job: JobStatus; id: string }> {
  return Object.values(jobs).flatMap((job) => (job.approvals ?? []).map((approval) => ({ job, id: approval.id })));
}

/** "claude.ai Gmail" → "Gmail". */
function serverName(server: string): string {
  return server.replace(/^claude\.ai\s+/i, "");
}

/**
 * A connector tool that acts, waiting for the person: what it would do, Allow or Deny.
 * Names and arguments come from the person's config and the model: shown as plain text.
 */
function ApprovalCard({ job, approval }: { job: JobStatus; approval: NonNullable<JobStatus["approvals"]>[number] }) {
  const jobAction = useMulch((s) => s.jobAction);
  const entries = Object.entries(approval.input);
  return (
    <div className="rounded-2xl border-[1.5px] border-ink bg-chrome px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-[13.5px] font-medium">
        <span className="h-2 w-2 rounded-full bg-amber shrink-0" />
        <span className="truncate">
          {serverName(approval.server)}: {approval.tool.replace(/_/g, " ")}
        </span>
      </div>
      {entries.length > 0 && (
        <dl className="mt-1.5 max-h-48 overflow-auto text-[12.5px] leading-snug space-y-1">
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt className="text-ink-3">{key}</dt>
              <dd className="text-ink-2 whitespace-pre-wrap break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-2 flex justify-end gap-1.5">
        <button onClick={() => void jobAction("deny", { jobId: job.id, approvalId: approval.id })} className="h-7 px-2.5 rounded-lg text-[12.5px] text-ink-2 hover:bg-paper-2 hover:text-ink">
          Deny
        </button>
        <button onClick={() => void jobAction("allow", { jobId: job.id, approvalId: approval.id })} className="h-7 px-3 rounded-lg bg-ink text-chrome text-[12.5px] font-medium hover:opacity-90">
          Allow
        </button>
      </div>
    </div>
  );
}

/** Messages not yet read: a dot on the button, and the panel opens for them. */
export function unreadMessages(jobs: Record<string, JobStatus>): JobStatus[] {
  return Object.values(jobs).filter((job) => job.message && !job.message.dismissed);
}

function Took({ jobs }: { jobs: JobStatus[] }) {
  const setFocus = useMulch((s) => s.setFocus);
  const nodes = useMulch((s) => s.mulch?.nodes);
  const parts = jobs.flatMap((job) => {
    if (job.lane === "command") return [{ text: "→ instruction", ids: [] as string[] }];
    const ids = (job.resultIds ?? []).filter((id) => nodes?.[id]);
    if (job.state === "running" || job.state === "queued") return [{ text: "→ capturing", ids }];
    return ids.length ? [{ text: `→ ${ids.length} ${ids.length === 1 ? "card" : "cards"}`, ids }] : [];
  });
  if (!parts.length) return null;
  return (
    <div className="mt-1 flex gap-2 text-[11.5px] text-ink-3">
      {parts.map((part, i) =>
        part.ids.length ? (
          <button key={i} onClick={() => setFocus({ ids: part.ids })} className="hover:text-ink underline-offset-2 hover:underline">
            {part.text}
          </button>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </div>
  );
}

function JobEntry({ job }: { job: JobStatus }) {
  const jobAction = useMulch((s) => s.jobAction);
  const setFocus = useMulch((s) => s.setFocus);
  const nodes = useMulch((s) => s.mulch?.nodes);
  const results = (job.resultIds ?? []).filter((id) => nodes?.[id]);
  const typed = job.retry?.kind === "command" && !job.inputIds?.length;
  const running = job.state === "queued" || job.state === "running";
  return (
    <div className="space-y-2">
      {/* A typed instruction is the person's own line; a spoken one shows as what they said, above. */}
      {typed && (
        <div className="ml-8 rounded-2xl rounded-br-md bg-paper-2 px-3.5 py-2 text-[14px] leading-snug whitespace-pre-wrap">{job.retry!.input}</div>
      )}
      <div className="text-[13px] text-ink-2">
        <div className="flex items-center gap-2">
          {running ? <Scribble which="bottom" mode="loop" strokeWidth={11} className="h-2.5 w-7 text-ink shrink-0" /> : <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${job.state === "failed" ? "bg-danger" : "bg-line-2"}`} />}
          <span className={`truncate ${typed ? "text-ink-3" : "text-ink"}`}>{typed ? (running ? (job.activity ?? "Working") : job.state === "failed" ? "Failed" : "Done") : job.label}</span>
          {(job.finishedAt ?? job.startedAt ?? job.queuedAt) && <span className="ml-auto shrink-0 tabular-nums text-[11.5px] text-ink-3">{clock((job.finishedAt ?? job.startedAt ?? job.queuedAt)!)}</span>}
        </div>
        {running && !typed && job.activity && <p className="mt-0.5 pl-9 text-[12px] text-ink-3 truncate">{job.activity}</p>}
        {job.state === "failed" && <p className="mt-0.5 pl-9 text-[12.5px] text-danger">{job.error ?? "Failed"}</p>}
        <div className="mt-1 pl-9 flex gap-1.5">
          {results.length > 0 && (
            <button onClick={() => setFocus({ ids: results })} className="text-[12px] text-ink-2 hover:text-ink underline-offset-2 hover:underline">
              Show {results.length === 1 ? "1 item" : `${results.length} items`}
            </button>
          )}
          {running && job.retry && (
            <button onClick={() => void jobAction("cancel", { jobId: job.id })} className="text-[12px] text-ink-3 hover:text-ink inline-flex items-center gap-1">
              <Square size={9} strokeWidth={2.5} /> Stop
            </button>
          )}
          {job.state === "failed" && job.retry && (
            <button onClick={() => void jobAction("retry", { jobId: job.id })} className="text-[12px] text-ink-2 hover:text-ink inline-flex items-center gap-1">
              <RotateCcw size={10} strokeWidth={2.25} /> Retry
            </button>
          )}
        </div>
      </div>
      {job.approvals?.map((approval) => <ApprovalCard key={approval.id} job={job} approval={approval} />)}
      {job.message && (
        <div className="rounded-2xl rounded-bl-md border border-line bg-chrome px-3.5 py-2.5">
          <div className="mlch-md text-[14px] leading-[1.5]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.message.text}</ReactMarkdown>
          </div>
          <div className="mt-1.5 flex justify-end">
            <button onClick={() => void jobAction("keep-message", { jobId: job.id })} className="h-6 px-2 rounded-md text-[12px] text-ink-3 hover:bg-paper-2 hover:text-ink">
              Add to canvas
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Conversation() {
  const open = useConversation((s) => s.open);
  const setOpen = useConversation((s) => s.setOpen);
  const transcript = useMulch((s) => s.transcript);
  const jobs = useMulch((s) => s.jobs);
  const jobAction = useMulch((s) => s.jobAction);
  const recording = useVoice((s) => s.recording);
  const speaking = useVoice((s) => s.speaking);
  const pending = useVoice((s) => s.pending);
  const bottom = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const all = Object.values(jobs);
    // Each piece of speech or typing with the jobs that took it; the person's instructions and long work as their own entries.
    const said: Entry[] = transcript.map((segment) => ({ kind: "said", at: segment.at, segment, took: all.filter((job) => job.inputIds?.includes(segment.id) && job.lane !== "slow") }));
    const kept: Entry[] = all.filter((job) => job.retry).map((job) => ({ kind: "job", at: job.queuedAt ?? job.startedAt ?? 0, job }));
    return [...said, ...kept].sort((a, b) => a.at - b.at).slice(-300);
  }, [transcript, jobs]);

  // Reading the panel reads the messages in it.
  const unread = unreadMessages(jobs);
  useEffect(() => {
    if (!open) return;
    for (const job of unread) void jobAction("dismiss-message", { jobId: job.id });
  }, [open, unread, jobAction]);
  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ block: "end" });
  }, [open, entries.length]);

  if (!open) return null;
  return (
    <aside className="float w-[min(380px,34%)] shrink-0 my-3 mr-3 rounded-2xl flex flex-col overflow-hidden" aria-label="Conversation">
      <div className="h-12 shrink-0 flex items-center pl-5 pr-3">
        <span className="text-[13.5px] font-semibold">Conversation</span>
        <div className="flex-1" />
        <button onClick={() => setOpen(false)} title="Close" aria-label="Close" className="p-1.5 rounded-lg hover:bg-paper-2 text-ink-2 hover:text-ink">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex-1 overflow-auto px-5 pb-5 space-y-4">
        {!entries.length && <p className="pt-6 text-[13px] text-ink-3">What you say and type, and what the AI does with it, shows here.</p>}
        {entries.map((entry) =>
          entry.kind === "said" ? (
            <div key={entry.segment.id} className="ml-8">
              <div className="rounded-2xl rounded-br-md bg-paper-2 px-3.5 py-2 text-[14px] leading-snug">
                {entry.segment.speaker && <span className="text-ink-3">{entry.segment.speaker === "me" ? "Me: " : "Them: "}</span>}
                {entry.segment.text}
              </div>
              <div className="flex justify-between">
                <Took jobs={entry.took} />
                <span className="mt-1 text-[11px] text-ink-3 tabular-nums">{clock(entry.at)}</span>
              </div>
            </div>
          ) : (
            <JobEntry key={entry.job.id} job={entry.job} />
          ),
        )}
        {(recording || pending > 0) && (
          <div className="ml-8 flex justify-end">
            <Scribble which="top" mode="live" active={speaking || pending > 0} duration={2.2} strokeWidth={9} className="h-5 w-auto text-ink" style={{ opacity: speaking || pending > 0 ? 0.85 : 0.35 }} />
          </div>
        )}
        <div ref={bottom} />
      </div>
    </aside>
  );
}

/** Opens the panel when the AI writes to the person (or a call starts), once per message. */
export function useConversationOpener(): void {
  const jobs = useMulch((s) => s.jobs);
  const loaded = useMulch((s) => !!s.mulch);
  const inCall = useVoice((s) => !!s.call);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);
  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE) === "1") useConversation.setState({ open: true });
    } catch {}
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const unread = unreadMessages(jobs);
    // Messages already there when the mulch opened only light the dot.
    if (first.current) {
      first.current = false;
      for (const job of unread) seen.current.add(`${job.id}:${job.message!.at}`);
      return;
    }
    for (const job of unread) {
      const key = `${job.id}:${job.message!.at}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      useConversation.getState().setOpen(true);
    }
    // A connector tool waiting for the person always opens the panel: the work can't go on without them.
    for (const { id } of waitingApprovals(jobs)) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      useConversation.getState().setOpen(true);
    }
  }, [jobs, loaded]);
  useEffect(() => {
    if (inCall) useConversation.getState().setOpen(true);
  }, [inCall]);
}
