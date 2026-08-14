type Props = {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
};

export function FilterPill({ label, value, onChange, options, disabled }: Props) {
  return (
    <label className={`filter-pill${disabled ? " is-disabled" : ""}`}>
      <span className="filter-pill-label">{label}</span>
      <select
        value={String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
