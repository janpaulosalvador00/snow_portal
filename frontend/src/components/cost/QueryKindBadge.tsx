import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  QUERY_KIND_COLOR_SWATCHES,
  QUERY_KIND_CUSTOM_MAX,
  QUERY_KIND_OPTIONS,
  defaultColorForQueryKind,
  normalizeCustomQueryKind,
  normalizeQueryKindColor,
  queryKindCssClass,
  resolveQueryKindColor,
  type QueryKind,
} from "./queryKind";

export type QueryKindBadgeChange = {
  kind: string;
  color: string;
} | null;

type Props = {
  kind: string;
  /** Saved accent override; null/undefined → kind default. */
  color?: string | null;
  overridden: boolean;
  queryType?: string | null;
  disabled?: boolean;
  onChange: (next: QueryKindBadgeChange) => void;
};

const OTHER_VALUE = "__other__";

function badgeAccentStyle(accent: string): CSSProperties {
  return { ["--kind-accent" as string]: accent };
}

export function QueryKindBadge({ kind, color, overridden, queryType, disabled, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draftKind, setDraftKind] = useState(kind);
  const [draftCustom, setDraftCustom] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [draftColor, setDraftColor] = useState(resolveQueryKindColor(kind, color));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;

  const accent = resolveQueryKindColor(kind, color);
  const knownSelected = (QUERY_KIND_OPTIONS as readonly string[]).includes(kind);

  function openModal() {
    if (disabled) return;
    const isCustom = overridden && !knownSelected;
    setDraftKind(kind);
    setUseCustom(isCustom);
    setDraftCustom(isCustom ? kind : "");
    setDraftColor(resolveQueryKindColor(kind, color));
    setOpen(true);
  }

  function closeModal(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  function resolvedDraftKind(): string | null {
    if (useCustom) return normalizeCustomQueryKind(draftCustom);
    return draftKind.trim() || null;
  }

  function applySave() {
    const nextKind = resolvedDraftKind();
    if (!nextKind) return;
    const nextColor = normalizeQueryKindColor(draftColor) || defaultColorForQueryKind(nextKind);
    onChange({ kind: nextKind, color: nextColor });
    closeModal(true);
  }

  function applyReset() {
    onChange(null);
    closeModal(true);
  }

  function selectKind(value: string) {
    if (value === OTHER_VALUE) {
      setUseCustom(true);
      setDraftCustom(overridden && !knownSelected ? kind : "");
      return;
    }
    setUseCustom(false);
    setDraftKind(value);
    // When switching kind, snap color to that kind's default unless user already
    // picked a non-default swatch for the previous draft (keep their pick).
    const prevDefault = defaultColorForQueryKind(useCustom ? draftCustom || kind : draftKind);
    if (normalizeQueryKindColor(draftColor) === normalizeQueryKindColor(prevDefault)) {
      setDraftColor(defaultColorForQueryKind(value));
    }
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.classList.add("modal-open");
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("modal-open");
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (useCustom) {
      customInputRef.current?.focus();
      customInputRef.current?.select();
      return;
    }
    dialogRef.current?.querySelector<HTMLElement>("button.perf-kind-type-option.selected")?.focus();
  }, [open, useCustom]);

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openModal();
    }
  }

  const titleParts = [
    queryType ? `QUERY_TYPE: ${queryType}` : null,
    overridden ? "Editado manualmente — clique para alterar" : "Clique para classificar",
  ].filter(Boolean);

  const canSave = Boolean(resolvedDraftKind());
  const colorNormalized = normalizeQueryKindColor(draftColor) || draftColor;

  const modal = open
    ? createPortal(
        <div
          className="admin-modal-backdrop perf-kind-modal-backdrop"
          role="presentation"
          onClick={() => closeModal(false)}
        >
          <div
            ref={dialogRef}
            className="admin-modal perf-kind-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="admin-modal-head">
              <div>
                <h2 id={titleId}>Tipo da query</h2>
                <p className="admin-modal-lead">Escolha o tipo e a cor do badge</p>
              </div>
              <button
                type="button"
                className="btn admin-modal-close"
                onClick={() => closeModal(true)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>

            <div className="perf-kind-modal-body">
              <div className="perf-kind-modal-preview" aria-hidden>
                <span
                  className={`perf-kind-badge has-accent ${queryKindCssClass(resolvedDraftKind() || kind)}`}
                  style={badgeAccentStyle(colorNormalized)}
                >
                  <span className="perf-kind-label">{resolvedDraftKind() || kind}</span>
                </span>
              </div>

              <fieldset className="perf-kind-modal-fieldset">
                <legend>Tipo</legend>
                <div className="perf-kind-type-list" role="listbox" aria-label="Tipo">
                  {QUERY_KIND_OPTIONS.map((opt: QueryKind) => {
                    const selected = !useCustom && draftKind === opt;
                    return (
                      <button
                        key={opt}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={`perf-kind-type-option${selected ? " selected" : ""}`}
                        onClick={() => selectKind(opt)}
                      >
                        <span
                          className="perf-kind-type-swatch"
                          style={{ background: defaultColorForQueryKind(opt) }}
                          aria-hidden
                        />
                        <span>{opt}</span>
                        {selected ? <span aria-hidden>✓</span> : null}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="option"
                    aria-selected={useCustom}
                    className={`perf-kind-type-option${useCustom ? " selected" : ""}`}
                    onClick={() => selectKind(OTHER_VALUE)}
                  >
                    <span
                      className="perf-kind-type-swatch"
                      style={{ background: defaultColorForQueryKind("CUSTOM") }}
                      aria-hidden
                    />
                    <span>Outro…</span>
                    {useCustom ? <span aria-hidden>✓</span> : null}
                  </button>
                </div>
                {useCustom ? (
                  <label className="perf-kind-custom-field" htmlFor={`${baseId}-custom`}>
                    Nome personalizado
                    <input
                      ref={customInputRef}
                      id={`${baseId}-custom`}
                      className="perf-kind-custom-input"
                      value={draftCustom}
                      maxLength={QUERY_KIND_CUSTOM_MAX}
                      placeholder="ex. TASK"
                      onChange={(e) => setDraftCustom(e.target.value)}
                    />
                  </label>
                ) : null}
              </fieldset>

              <fieldset className="perf-kind-modal-fieldset">
                <legend>Cor</legend>
                <div className="perf-kind-color-row">
                  <div className="perf-kind-swatches" role="list" aria-label="Cores sugeridas">
                    {QUERY_KIND_COLOR_SWATCHES.map((swatch) => {
                      const active =
                        normalizeQueryKindColor(draftColor) === normalizeQueryKindColor(swatch);
                      return (
                        <button
                          key={swatch}
                          type="button"
                          role="listitem"
                          className={`perf-kind-swatch${active ? " selected" : ""}`}
                          style={{ background: swatch }}
                          title={swatch}
                          aria-label={`Cor ${swatch}`}
                          aria-pressed={active}
                          onClick={() => setDraftColor(swatch)}
                        />
                      );
                    })}
                  </div>
                  <label className="perf-kind-color-picker-label" htmlFor={`${baseId}-color`}>
                    <span>Personalizar</span>
                    <input
                      id={`${baseId}-color`}
                      type="color"
                      className="perf-kind-color-picker"
                      value={colorNormalized.startsWith("#") && colorNormalized.length === 7 ? colorNormalized : "#29b5e8"}
                      onChange={(e) => setDraftColor(e.target.value)}
                    />
                  </label>
                </div>
              </fieldset>
            </div>

            <div className="admin-modal-actions perf-kind-modal-actions">
              {overridden ? (
                <button type="button" className="btn perf-kind-reset-btn" onClick={applyReset}>
                  Restaurar automático
                </button>
              ) : (
                <span />
              )}
              <div className="perf-kind-modal-actions-end">
                <button type="button" className="btn" onClick={() => closeModal(true)}>
                  Cancelar
                </button>
                <button type="button" className="btn primary" disabled={!canSave} onClick={applySave}>
                  Salvar
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`perf-kind-badge has-accent ${queryKindCssClass(kind)}${overridden ? " is-overridden" : ""}${
          open ? " is-open" : ""
        }`}
        style={badgeAccentStyle(accent)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={titleParts.join(" · ")}
        onClick={(e) => {
          e.stopPropagation();
          if (open) closeModal(false);
          else openModal();
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
      {modal}
    </>
  );
}
