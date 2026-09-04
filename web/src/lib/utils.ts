import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Render a Slack user id as "@DisplayName" using a names map, falling back to
 * "@<id>" when the name is unknown. `names` may be undefined. */
export function uname(id: string, names?: Record<string, string>): string {
  return `@${names?.[id] ?? id}`;
}

/** Rewrite Slack mrkdwn mentions embedded in free text — `<@U…>` (optionally
 * `<@U…|label>`) → "@Name", and `<#C…|label>` → "#label" (or "#channel") — using
 * the names map for users. Unknown users fall back to "@<id>". */
export function renderMentions(text: string, names?: Record<string, string>): string {
  if (!text) return text;
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id: string) => uname(id, names))
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, _id: string, label?: string) => `#${label || "channel"}`);
}
