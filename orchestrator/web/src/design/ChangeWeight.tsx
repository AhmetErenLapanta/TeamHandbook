import { SQUARES, weightOf } from "./change-weight";

/** A change's size and its added-to-removed share as five squares, the same on a task's row and on each of its files. */
export function ChangeWeight({ added, removed }: { added: number; removed: number }) {
  const weight = weightOf(added, removed);
  const kinds = [...Array(weight.added).fill("add"), ...Array(weight.removed).fill("del"), ...Array(weight.empty).fill("none")] as string[];
  return (
    <span className="change-weight" role="img" aria-label={`${added} ${added === 1 ? "line" : "lines"} added, ${removed} removed`}>
      {kinds.slice(0, SQUARES).map((kind, i) => <i key={i} className={kind} />)}
    </span>
  );
}
