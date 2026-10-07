"use client";

import { SCRIBBLES } from "./scribbles";

/**
 * The logo's scribbles, the one animated motif in the interface.
 *   still  drawn, not moving (empty canvas)
 *   loop   drawn and undrawn continuously (the AI is working)
 *   live   like loop, but runs only while `active` (listening: moves while you speak)
 */
export function Scribble({
  which = "top",
  mode = "still",
  active = true,
  strokeWidth = 8,
  duration = 2.6,
  className,
  style,
}: {
  which?: keyof typeof SCRIBBLES;
  mode?: "still" | "loop" | "live";
  active?: boolean;
  strokeWidth?: number;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { d, viewBox } = SCRIBBLES[which];
  const animated = mode !== "still";
  return (
    <svg viewBox={viewBox} className={`${animated ? "scribble-anim" : ""} ${className ?? ""}`} style={style} aria-hidden="true" fill="none">
      <path
        d={d}
        pathLength={1}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={
          animated
            ? ({
                "--scribble-length": 1,
                strokeDasharray: 1,
                animation: `scribble-loop ${duration}s cubic-bezier(0.45, 0, 0.55, 1) infinite`,
                animationPlayState: mode === "live" && !active ? "paused" : "running",
              } as React.CSSProperties)
            : undefined
        }
      />
    </svg>
  );
}

/** The "mlch" lettering from the logo. */
export function Wordmark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/brand/wordmark.svg" alt="mlch" className={className} draggable={false} />;
}
