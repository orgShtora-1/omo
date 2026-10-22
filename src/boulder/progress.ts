export interface PlanProgress {
  total: number
  completed: number
  remaining: number
  next: { line: number; label: string } | null
}

/** Top-level task progress; fenced examples and indented details are not work. */
export function planProgress(markdown: string): PlanProgress {
  const progress: PlanProgress = { total: 0, completed: 0, remaining: 0, next: null }
  let fence: { marker: string; length: number } | undefined
  const lines = markdown.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        delimiter &&
        delimiter[1]?.[0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        delimiter[2]?.trim() === ""
      ) {
        fence = undefined
      }
      continue
    }
    if (delimiter?.[1]) {
      fence = { marker: delimiter[1][0] ?? "", length: delimiter[1].length }
      continue
    }
    const task = /^(?:[-+*]|\d+[.)]) +\[([ xX])\] +(.+?)\s*$/.exec(line)
    if (!task) continue
    progress.total += 1
    if (task[1]?.toLowerCase() === "x") progress.completed += 1
    else {
      progress.remaining += 1
      progress.next ??= { line: index + 1, label: task[2] ?? "" }
    }
  }
  return progress
}
