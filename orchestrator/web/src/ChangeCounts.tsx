/** A change's added and removed lines as "+6 −2"; a side with none is not written, so "+6" alone is a change that only adds. */
export function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      {added ? <span className="diff-add">+{added}</span> : null}
      {added && removed ? " " : null}
      {removed ? <span className="diff-del">−{removed}</span> : null}
    </>
  );
}
