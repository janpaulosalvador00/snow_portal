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
  const max = rows[0]?.credits_used || 1;
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
          <span className="mono">{row.name}</span>
          <span>{row.type}</span>
          <span className="muted">{row.tags || "—"}</span>
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
