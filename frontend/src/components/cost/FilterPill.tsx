import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type FilterPillOption = {
  value: string;
  label: string;
  /** Renders a dot marker ("Teve consumo no período") next to the label. */
  consumed?: boolean;
};

type Props = {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  options: FilterPillOption[];
  disabled?: boolean;
};

type MenuPos = {
  left: number;
  minWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

const MENU_MAX_HEIGHT = 320;
const MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;
const OPTION_HEIGHT_ESTIMATE = 34;
const TYPEAHEAD_RESET_MS = 600;
const CONSUMED_TITLE = "Teve consumo no período";

function scrollOptionIntoView(menu: HTMLElement, option: HTMLElement, center: boolean) {
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (center) {
    menu.scrollTop = Math.max(0, top - (menu.clientHeight - option.offsetHeight) / 2);
    return;
  }
  if (top < menu.scrollTop) menu.scrollTop = top;
  else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
}

export function FilterPill({ label, value, onChange, options, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef<{ buffer: string; timer: number | undefined }>({
    buffer: "",
    timer: undefined,
  });
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const valueId = `${baseId}-value`;
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const selectedIndex = options.findIndex((o) => o.value === String(value));
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  function openMenu(index?: number) {
    if (disabled || options.length === 0) return;
    setActiveIndex(index ?? (selectedIndex >= 0 ? selectedIndex : 0));
    setOpen(true);
  }

  function closeMenu(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function choose(index: number) {
    const opt = options[index];
    if (!opt) return;
    if (opt.value !== String(value)) onChange(opt.value);
    closeMenu(true);
  }

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    function place() {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const desired = Math.min(MENU_MAX_HEIGHT, vh * 0.5);
      const natural = menuRef.current?.scrollHeight ?? options.length * OPTION_HEIGHT_ESTIMATE + 12;
      const needed = Math.min(desired, natural);
      const below = vh - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const minWidth = Math.max(rect.width, 200);
      const width = Math.max(menuRef.current?.offsetWidth ?? minWidth, minWidth);
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, vw - width - VIEWPORT_MARGIN));
      if (below >= needed || below >= above) {
        setMenuPos({ left, minWidth, top: rect.bottom + MENU_GAP, maxHeight: Math.min(desired, below) });
      } else {
        setMenuPos({ left, minWidth, bottom: vh - rect.top + MENU_GAP, maxHeight: Math.min(desired, above) });
      }
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, options.length]);

  // Once positioned: focus the list and bring the selected row into view.
  const positioned = menuPos !== null;
  useLayoutEffect(() => {
    if (!open || !positioned) return;
    const menu = menuRef.current;
    if (!menu) return;
    menu.focus({ preventScroll: true });
    const idx = selectedIndex >= 0 ? selectedIndex : activeIndex;
    const el = idx >= 0 ? document.getElementById(optionId(idx)) : null;
    if (el) scrollOptionIntoView(menu, el, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, positioned]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const menu = menuRef.current;
    const el = document.getElementById(optionId(activeIndex));
    if (menu && el) scrollOptionIntoView(menu, el, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  function runTypeahead(char: string) {
    const ta = typeahead.current;
    window.clearTimeout(ta.timer);
    ta.buffer += char.toLowerCase();
    ta.timer = window.setTimeout(() => {
      ta.buffer = "";
    }, TYPEAHEAD_RESET_MS);
    const buf = ta.buffer;
    const repeated = buf.length > 1 && buf.split("").every((c) => c === buf[0]);
    const query = repeated ? buf[0] : buf;
    const start = activeIndex < 0 ? 0 : activeIndex;
    const n = options.length;
    const offset = query.length === 1 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const i = (start + offset + k) % n;
      if (options[i].label.toLowerCase().startsWith(query)) {
        setActiveIndex(i);
        return;
      }
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    switch (e.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        e.preventDefault();
        openMenu();
        break;
      case "ArrowUp":
        e.preventDefault();
        openMenu();
        break;
      case "Home":
        e.preventDefault();
        openMenu(0);
        break;
      case "End":
        e.preventDefault();
        openMenu(options.length - 1);
        break;
    }
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLUListElement>) {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(last, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(last);
        break;
      case "PageDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(last, i + 8));
        break;
      case "PageUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 8));
        break;
      case "Enter":
        e.preventDefault();
        choose(activeIndex);
        break;
      case " ":
        e.preventDefault();
        if (typeahead.current.buffer) runTypeahead(" ");
        else choose(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        closeMenu(true);
        break;
      case "Tab":
        closeMenu(false);
        break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          runTypeahead(e.key);
        }
    }
  }

  const menu =
    open && menuPos
      ? createPortal(
          <ul
            id={listId}
            ref={menuRef}
            className="fp-menu"
            role="listbox"
            tabIndex={-1}
            aria-labelledby={labelId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            onKeyDown={onListKeyDown}
            style={{
              top: menuPos.top,
              bottom: menuPos.bottom,
              left: menuPos.left,
              minWidth: menuPos.minWidth,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {options.map((o, i) => {
              const isSelected = i === selectedIndex;
              return (
                <li
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  aria-selected={isSelected}
                  className={`fp-option${isSelected ? " selected" : ""}${
                    i === activeIndex ? " active" : ""
                  }`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(i)}
                >
                  <span className="fp-option-label">{o.label}</span>
                  {o.consumed ? (
                    <span className="fp-consumed-dot" title={CONSUMED_TITLE}>
                      <span className="sr-only">{CONSUMED_TITLE}</span>
                    </span>
                  ) : null}
                  <span className="fp-check" aria-hidden>
                    {isSelected ? "✓" : ""}
                  </span>
                </li>
              );
            })}
          </ul>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`filter-pill fp-trigger${disabled ? " is-disabled" : ""}${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="filter-pill-label" id={labelId}>
          {label}
        </span>
        <span className="fp-value" id={valueId}>
          {selected ? selected.label : String(value)}
        </span>
        <span className="fp-chevron" aria-hidden>
          ▾
        </span>
      </button>
      {menu}
    </>
  );
}
