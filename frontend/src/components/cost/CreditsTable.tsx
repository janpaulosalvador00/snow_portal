type Row = {
  name: string;
  type: string;
  tags: string;
  credits_used: number;
};

type Props = {
  rows: Row[];
};

export function CreditsTable({ rows }: Props) {
  if (!rows.length) {
    return <div className="info-box">Nenhum recurso no filtro atual.</div>;
  }
  const max = Math.max(...rows.map((r) => r.credits_used), 1);
  return (
    <div className="table cost-table cost-table-credits">
      <div className="table-head">
        <span>NAME</span>
        <span>TYPE</span>
        <span>TAGS</span>
        <span>CREDITS USED</span>
      </div>
      {rows.map((row) => (
        <div key={row.name + row.type} className="table-row">
          <span className="mono credits-name" title={row.name}>
            {row.name}
          </span>
          <span className="credits-type" title={row.type}>
            {row.type}
          </span>
          <span className="muted credits-tags" title={row.tags || undefined}>
            {row.tags || "—"}
          </span>
          <span className="credits-cell">
            <span
              className="bar"
              style={{ width: `${Math.min(100, (row.credits_used / max) * 100)}%` }}
            />
            <em>{row.credits_used.toFixed(1)}</em>
          </span>
        </div>
      ))}
    </div>
  );
}
