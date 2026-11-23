import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  QUERY_KIND_CUSTOM_MAX,
  QUERY_KIND_OPTIONS,
  normalizeCustomQueryKind,
  queryKindCssClass,
  type QueryKind,
} from "./queryKind";

type Props = {
  kind: string;
  overridden: boolean;
  queryType?: string | null;
  disabled?: boolean;
  onChange: (next: string | null) => void;
};

type MenuPos = {
  left: number;
  minWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

const MENU_MAX_HEIGHT = 320;
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;
const OTHER_VALUE = "__other__";
const RESET_VALUE = "__reset__";

export function QueryKindBadge({ kind, overridden, queryType, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const options: { value: string; label: string }[] = [
    ...QUERY_KIND_OPTIONS.map((k: QueryKind) => ({ value: k, label: k })),
    { value: OTHER_VALUE, label: "Outro…" },
  ];
  if (overridden) {
    options.push({ value: RESET_VALUE, label: "Restaurar automático" });
  }

  const selectedIndex = options.findIndex((o) => o.value === kind);

  function openMenu() {
    if (disabled) return;
    setCustomMode(false);
    setCustomText("");
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function closeMenu(returnFocus: boolean) {
    setOpen(false);
    setCustomMode(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function applyKind(value: string | null) {
    onChange(value);
    closeMenu(true);
  }

  function choose(index: number) {
    const opt = options[index];
    if (!opt) return;
    if (opt.value === RESET_VALUE) {
      applyKind(null);
      return;
    }
    if (opt.value === OTHER_VALUE) {
      setCustomMode(true);
      setCustomText(overridden && !QUERY_KIND_OPTIONS.includes(kind as QueryKind) ? kind : "");
      return;
    }
    applyKind(opt.value);
  }

  function submitCustom() {
    const normalized = normalizeCustomQueryKind(customText);
    if (!normalized) return;
    applyKind(normalized);
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
      const desired = Math.min(MENU_MAX_HEIGHT, vh * 0.45);
      const natural = menuRef.current?.scrollHeight ?? options.length * 32 + 12;
      const needed = Math.min(desired, natural);
      const below = vh - rect.bottom - MENU_GAP - VIEWPORT_MARGIN;
      const above = rect.top - MENU_GAP - VIEWPORT_MARGIN;
      const minWidth = Math.max(rect.width, 160);
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
  }, [open, options.length, customMode]);

  useLayoutEffect(() => {
    if (!open || !customMode) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, customMode]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
      setCustomMode(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openMenu();
    }
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (customMode) return;
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
      case "Enter":
      case " ":
        e.preventDefault();
        choose(activeIndex);
        break;
      case "Escape":
        e.preventDefault();
        closeMenu(true);
        break;
      case "Tab":
        closeMenu(false);
        break;
    }
  }

  const titleParts = [
    queryType ? `QUERY_TYPE: ${queryType}` : null,
    overridden ? "Editado manualmente — clique para alterar" : "Clique para classificar",
  ].filter(Boolean);

  const menu =
    open && menuPos
      ? createPortal(
          <div
            ref={menuRef}
            id={listId}
            className="perf-kind-menu"
            role="listbox"
            tabIndex={-1}
            aria-label="Tipo da query"
            onKeyDown={onListKeyDown}
            style={{
              top: menuPos.top,
              bottom: menuPos.bottom,
              left: menuPos.left,
              minWidth: menuPos.minWidth,
              maxHeight: menuPos.maxHeight,
            }}
          >
            {customMode ? (
              <form
                className="perf-kind-custom"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitCustom();
                }}
              >
                <label className="perf-kind-custom-label" htmlFor={`${baseId}-custom`}>
                  Outro tipo
                </label>
                <input
                  ref={inputRef}
                  id={`${baseId}-custom`}
                  className="perf-kind-custom-input"
                  value={customText}
                  maxLength={QUERY_KIND_CUSTOM_MAX}
                  placeholder="ex. TASK"
                  onChange={(e) => setCustomText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setCustomMode(false);
                    }
                  }}
                />
                <div className="perf-kind-custom-actions">
                  <button type="button" className="perf-kind-custom-btn" onClick={() => setCustomMode(false)}>
                    Voltar
                  </button>
                  <button type="submit" className="perf-kind-custom-btn is-primary" disabled={!customText.trim()}>
                    Salvar
                  </button>
                </div>
              </form>
            ) : (
              options.map((o, i) => {
                const isSelected =
                  o.value === kind || (o.value === OTHER_VALUE && overridden && !QUERY_KIND_OPTIONS.includes(kind as QueryKind));
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`perf-kind-option${isSelected ? " selected" : ""}${
                      i === activeIndex ? " active" : ""
                    }${o.value === RESET_VALUE ? " is-reset" : ""}`}
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(i)}
                  >
                    <span>{o.label}</span>
                    {isSelected && o.value !== OTHER_VALUE && o.value !== RESET_VALUE ? (
                      <span aria-hidden>✓</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`perf-kind-badge ${queryKindCssClass(kind)}${overridden ? " is-overridden" : ""}${
          open ? " is-open" : ""
        }`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={titleParts.join(" · ")}
        onClick={(e) => {
          e.stopPropagation();
          if (open) closeMenu(false);
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="perf-kind-label">{kind}</span>
        {overridden ? (
          <svg
            className="perf-kind-edit-icon"
            width="10"
            height="10"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.5 8.5A1.75 1.75 0 0 1 4.828 14H2.75A.75.75 0 0 1 2 13.25v-2.078c0-.464.185-.909.513-1.237l8.5-8.5Zm1.414 1.06a.25.25 0 0 0-.354 0L3.28 11.28a.25.25 0 0 0-.073.177v1.293h1.293a.25.25 0 0 0 .177-.073l8.793-8.793a.25.25 0 0 0 0-.354l-1.086-1.086Z"
            />
          </svg>
        ) : null}
      </button>
      {menu}
    </>
  );
}
