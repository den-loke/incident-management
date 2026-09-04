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
