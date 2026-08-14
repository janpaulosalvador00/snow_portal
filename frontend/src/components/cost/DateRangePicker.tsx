import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type DateRangeValue =
  | { mode: "preset"; days: number }
  | { mode: "custom"; start: string; end: string };

const PRESETS: { days: number; label: string }[] = [
  { days: 1, label: "Last day" },
  { days: 7, label: "Last 7 days" },
  { days: 28, label: "Last 28 days" },
  { days: 90, label: "Last 3 months" },
  { days: 180, label: "Last 6 months" },
  { days: 365, label: "Last 12 months" },
];

function toIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatShort(iso: string): string {
  return parseIso(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function labelFor(value: DateRangeValue): string {
  if (value.mode === "preset") {
    return PRESETS.find((p) => p.days === value.days)?.label ?? `Last ${value.days} days`;
  }
  return `${formatShort(value.start)} – ${formatShort(value.end)}`;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function MonthGrid({
  year,
  month0,
  start,
  end,
  onPick,
}: {
  year: number;
  month0: number;
  start: string | null;
  end: string | null;
  onPick: (iso: string) => void;
}) {
  const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const total = daysInMonth(year, month0);
  const title = new Date(Date.UTC(year, month0, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);

  return (
    <div className="drp-month">
      <div className="drp-month-title">{title}</div>
      <div className="drp-dow">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="drp-grid">
        {cells.map((d, i) => {
          if (d == null) return <span key={`e-${i}`} className="drp-day empty" />;
          const iso = toIso(new Date(Date.UTC(year, month0, d)));
          const inRange =
            start && end && iso >= start && iso <= end
              ? true
              : start && !end && iso === start;
          const isStart = start === iso;
          const isEnd = end === iso;
          return (
            <button
              key={iso}
              type="button"
              className={`drp-day${inRange ? " in-range" : ""}${isStart || isEnd ? " edge" : ""}`}
              onClick={() => onPick(iso)}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

type Props = {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
};

export function DateRangePicker({ value, onChange }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [draftStart, setDraftStart] = useState<string | null>(null);
  const [draftEnd, setDraftEnd] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [viewMonth, setViewMonth] = useState(() => {
    const now = new Date();
    return { y: now.getUTCFullYear(), m: now.getUTCMonth() };
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!menuOpen || !triggerRef.current) {
      setMenuPos(null);
      return;
    }
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({ top: rect.bottom + 8, left: rect.left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [menuOpen]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const nextMonth = useMemo(() => {
    if (viewMonth.m === 11) return { y: viewMonth.y + 1, m: 0 };
    return { y: viewMonth.y, m: viewMonth.m + 1 };
  }, [viewMonth]);

  function openCustom() {
    setMenuOpen(false);
    if (value.mode === "custom") {
      setDraftStart(value.start);
      setDraftEnd(value.end);
      const s = parseIso(value.start);
      setViewMonth({ y: s.getUTCFullYear(), m: s.getUTCMonth() });
    } else {
      const end = new Date();
      const start = new Date();
      start.setUTCDate(start.getUTCDate() - (value.days - 1));
      setDraftStart(toIso(start));
      setDraftEnd(toIso(end));
      setViewMonth({ y: start.getUTCFullYear(), m: start.getUTCMonth() });
    }
    setModalOpen(true);
  }

  function pickDay(iso: string) {
    if (!draftStart || (draftStart && draftEnd)) {
      setDraftStart(iso);
      setDraftEnd(null);
      return;
    }
    if (iso < draftStart) {
      setDraftEnd(draftStart);
      setDraftStart(iso);
    } else {
      setDraftEnd(iso);
    }
  }

  function applyCustom() {
    if (!draftStart || !draftEnd) return;
    onChange({ mode: "custom", start: draftStart, end: draftEnd });
    setModalOpen(false);
  }

  const menu =
    menuOpen && menuPos
      ? createPortal(
          <div
            className="drp-menu"
            role="listbox"
            ref={menuRef}
            style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
          >
            <div className="drp-menu-title">Date range</div>
            {PRESETS.map((p) => {
              const active = value.mode === "preset" && value.days === p.days;
              return (
                <button
                  key={p.days}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`drp-option${active ? " active" : ""}`}
                  onClick={() => {
                    onChange({ mode: "preset", days: p.days });
                    setMenuOpen(false);
                  }}
                >
                  <span>{p.label}</span>
                  {active ? <span className="drp-check">✓</span> : null}
                </button>
              );
            })}
            <button
              type="button"
              role="option"
              aria-selected={value.mode === "custom"}
              className={`drp-option${value.mode === "custom" ? " active" : ""}`}
              onClick={openCustom}
            >
              <span>Custom</span>
              {value.mode === "custom" ? <span className="drp-check">✓</span> : null}
            </button>
          </div>,
          document.body,
        )
      : null;

  const modal = modalOpen
    ? createPortal(
        <div className="drp-overlay" role="dialog" aria-modal="true" aria-label="Custom date range">
          <div className="drp-modal">
            <div className="drp-modal-side">
              {PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  className="drp-option"
                  onClick={() => {
                    onChange({ mode: "preset", days: p.days });
                    setModalOpen(false);
                  }}
                >
                  {p.label}
                </button>
              ))}
              <button type="button" className="drp-option active">
                Custom <span className="drp-check">✓</span>
              </button>
            </div>
            <div className="drp-modal-main">
              <div className="drp-mode-tabs">
                <span className="drp-mode active">Range</span>
                <span className="drp-mode disabled" title="Nesta onda só Range">
                  Last
                </span>
                <span className="drp-mode disabled">Before</span>
                <span className="drp-mode disabled">After</span>
              </div>
              <div className="drp-inputs">
                <input
                  type="text"
                  value={draftStart ?? ""}
                  onChange={(e) => setDraftStart(e.target.value)}
                  placeholder="YYYY-MM-DD"
                  aria-label="Start date"
                />
                <span>–</span>
                <input
                  type="text"
                  value={draftEnd ?? ""}
                  onChange={(e) => setDraftEnd(e.target.value)}
                  placeholder="YYYY-MM-DD"
                  aria-label="End date"
                />
                <span className="muted">UTC</span>
              </div>
              <div className="drp-nav">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() =>
                    setViewMonth((v) =>
                      v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 },
                    )
                  }
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() =>
                    setViewMonth((v) =>
                      v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 },
                    )
                  }
                >
                  ›
                </button>
              </div>
              <div className="drp-calendars">
                <MonthGrid
                  year={viewMonth.y}
                  month0={viewMonth.m}
                  start={draftStart}
                  end={draftEnd}
                  onPick={pickDay}
                />
                <MonthGrid
                  year={nextMonth.y}
                  month0={nextMonth.m}
                  start={draftStart}
                  end={draftEnd}
                  onPick={pickDay}
                />
              </div>
              <div className="drp-footer">
                <button type="button" className="btn" onClick={() => setModalOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!draftStart || !draftEnd}
                  onClick={applyCustom}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <div className="date-range-picker" ref={rootRef}>
      <button
        type="button"
        className="filter-pill date-range-trigger"
        ref={triggerRef}
        onClick={() => setMenuOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
      >
        <span className="drp-clock" aria-hidden>
          ⏱
        </span>
        <span>{labelFor(value)}</span>
        <span className="drp-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {menu}
      {modal}
    </div>
  );
}
