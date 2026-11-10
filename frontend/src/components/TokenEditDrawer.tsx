import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../api/client";
import { buildTokenPayload, emptyTokenChoice, type TokenChoice } from "../api/tokens";
import {
  deleteTokenRecord,
  editTokenConnection,
  getConnectionOptions,
  refreshOAuthToken,
  replaceTokenSecret,
  revokeToken,
  setTokenExpiry,
  startOAuthReconnect,
  type ConnectionOptions,
  type InventoryToken,
  type TokenMutationResponse,
} from "../api/tokenInventory";
import {
  connectionLabel,
  daysFromNowInput,
  expiryTone,
  formatAbsolute,
  formatRelative,
  fromLocalInput,
  SOURCE_LABELS,
  STATUS_LABELS,
  statusBadgeClass,
  toLocalInput,
  TYPE_LABELS,
} from "../pages/tokensFormat";
import { revealServiceUserGuide, ServiceUserGuide } from "./ServiceUserGuide";
import { TokenSourceField } from "./TokenSourceField";

type Props = {
  token: InventoryToken;
  now: number;
  onClose: () => void;
  /** A mutation succeeded: the updated row (drawer stays open). */
  onChanged: (token: InventoryToken | null) => void;
  /** The (revoked) row was deleted: close the drawer and show `message` on the page. */
  onDeleted: (message: string) => void;
};

type Busy = string | null;
type Notice = { kind: "ok" | "error"; text: string } | null;

type SectionProps = {
  token: InventoryToken;
  busy: Busy;
  setBusy: (busy: Busy) => void;
  onDone: (res: TokenMutationResponse) => void;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function errorText(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

function Section({
  title,
  hint,
  defaultOpen = false,
  onOpen,
  children,
}: {
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <details
      className="token-drawer-section"
      open={defaultOpen}
      onToggle={(e) => {
        if (e.currentTarget.open) onOpen?.();
      }}
    >
      <summary>
        <span className="token-drawer-section-title">{title}</span>
        {hint ? <span className="token-drawer-section-hint">{hint}</span> : null}
      </summary>
      <div className="token-drawer-section-body">{children}</div>
    </details>
  );
}

// ------------------------------------------------------------ Trocar valor

function ReplaceSecretSection({ token, busy, setBusy, onDone }: SectionProps) {
  const kind = token.token_type === "pat" ? "pat" : token.token_type === "private_key" ? "keypair" : "password";
  const idPrefix = `tok-${token.id}-secret`;
  const [choice, setChoice] = useState<TokenChoice>(() => ({
    ...emptyTokenChoice(),
    source: kind === "pat" ? "paste" : "file",
  }));
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideId = `${idPrefix}-guide`;
  const fingerprint = error?.includes("390144")
    ? (error.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null)
    : null;
  const username = token.connection?.username || token.username || "";
  const working = busy === "secret";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let payload;
    if (kind === "password") {
      if (!password) {
        setError("Informe a nova senha.");
        document.getElementById(`${idPrefix}-password`)?.focus();
        return;
      }
      payload = { secret: password, secret_source: "typed" as const };
    } else {
      const built = buildTokenPayload(kind, choice, idPrefix);
      if (!built.ok) {
        setError(built.error);
        document.getElementById(built.focusId)?.focus();
        return;
      }
      payload = built.payload;
    }
    setBusy("secret");
    try {
      const res = await replaceTokenSecret(token.id, {
        ...payload,
        ...(kind !== "password" && expiry ? { expires_at: fromLocalInput(expiry) } : {}),
      });
      setPassword("");
      setChoice({ ...emptyTokenChoice(), source: kind === "pat" ? "paste" : "file" });
      setExpiry("");
      onDone(res);
    } catch (err) {
      setError(errorText(err, "Falha ao trocar o valor."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form className="token-drawer-form" onSubmit={(e) => void submit(e)} autoComplete="off">
      <p className="token-drawer-help">
        O portal testa o novo valor no Snowflake antes de salvar. Se o teste falhar, nada muda.
      </p>
      {kind === "password" ? (
        <label htmlFor={`${idPrefix}-password`}>
          Nova senha
          <input
            id={`${idPrefix}-password`}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            aria-required="true"
          />
        </label>
      ) : (
        <>
          <TokenSourceField
            idPrefix={idPrefix}
            kind={kind}
            value={choice}
            onChange={setChoice}
            account={token.account_identifier || ""}
            username={username}
            onUseTokenIdentity={() => false}
            allowIdentityFill={false}
          />
          <label htmlFor={`${idPrefix}-expiry`}>
            Validade do novo valor (opcional)
            <input
              id={`${idPrefix}-expiry`}
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              aria-describedby={`${idPrefix}-expiry-hint`}
            />
          </label>
          <p id={`${idPrefix}-expiry-hint`} className="token-drawer-help">
            {kind === "pat"
              ? "Informe o vencimento do PAT (DAYS_TO_EXPIRY) para o portal avisar antes de expirar."
              : "Chaves RSA não expiram no Snowflake; preencha só se houver uma política de rotação."}
          </p>
        </>
      )}
      {error ? (
        <div className="error-box token-drawer-box" role="alert">
          {error}
          {fingerprint ? (
            <div className="row-actions" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className="btn"
                aria-controls={guideId}
                onClick={() => revealServiceUserGuide(guideId, setGuideOpen)}
              >
                Como registrar a chave no Snowflake
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy !== null} aria-busy={working}>
          {working ? "Testando no Snowflake…" : "Testar e salvar"}
        </button>
      </div>
      {kind !== "password" ? (
        <ServiceUserGuide
          method={kind}
          username={username}
          role={token.connection?.role_name || ""}
          fingerprint={fingerprint}
          id={guideId}
          open={guideOpen}
          onOpenChange={setGuideOpen}
        />
      ) : null}
    </form>
  );
}

// ------------------------------------------------------------ OAuth

function OAuthSection({ token, busy, setBusy, onDone }: SectionProps) {
  const [error, setError] = useState<string | null>(null);
  const { actions } = token;

  async function refresh() {
    setError(null);
    setBusy("refresh");
    try {
      onDone(await refreshOAuthToken(token.id));
    } catch (err) {
      setError(errorText(err, "Falha ao renovar o token OAuth."));
    } finally {
      setBusy(null);
    }
  }

  async function reconnect() {
    setError(null);
    setBusy("reconnect");
    try {
      const res = await startOAuthReconnect(token);
      window.location.href = res.authorize_url;
    } catch (err) {
      setError(errorText(err, "Falha ao iniciar o login via browser."));
      setBusy(null);
    }
  }

  return (
    <div className="token-drawer-form">
      {actions.refresh ? (
        <p className="token-drawer-help">
          <strong>Renovar agora</strong> usa o refresh token salvo para emitir um novo access token,
          sem sair do portal.
        </p>
      ) : null}
      {actions.reconnect ? (
        <p className="token-drawer-help">
          <strong>Reconectar via browser</strong> abre o login do Snowflake nesta aba e, ao concluir,
          volta para Tokens. Use quando o refresh token expirou ou foi revogado.
        </p>
      ) : null}
      {error ? (
        <div className="error-box token-drawer-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row-actions">
        {actions.refresh ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null}
            aria-busy={busy === "refresh"}
            onClick={() => void refresh()}
          >
            {busy === "refresh" ? "Renovando…" : "Renovar agora"}
          </button>
        ) : null}
        {actions.reconnect ? (
          <button
            type="button"
            className={actions.refresh ? "btn" : "btn primary"}
            disabled={busy !== null}
            aria-busy={busy === "reconnect"}
            onClick={() => void reconnect()}
          >
            {busy === "reconnect" ? "Abrindo login…" : "Reconectar via browser"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ Dados da conexão

function ConnectionSection({
  token,
  busy,
  setBusy,
  onDone,
  optionsRequested,
}: SectionProps & { optionsRequested: boolean }) {
  const conn = token.connection;
  const original = {
    name: conn?.name || "",
    username: conn?.username || "",
    role: conn?.role_name || "",
    warehouse: conn?.warehouse || "",
  };
  const [form, setForm] = useState(original);
  const [options, setOptions] = useState<ConnectionOptions | null>(null);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [optionsErr, setOptionsErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOAuth = token.token_type.startsWith("oauth_");
  const idPrefix = `tok-${token.id}-conn`;
  const working = busy === "connection";

  const changed = (Object.keys(original) as (keyof typeof original)[]).filter(
    (k) => form[k].trim() !== original[k],
  );
  const identityChange = changed.some((k) => k !== "name");

  async function loadOptions(refresh = false) {
    setOptionsBusy(true);
    setOptionsErr(null);
    try {
      setOptions(await getConnectionOptions(token.connection_id, refresh));
    } catch (err) {
      setOptionsErr(errorText(err, "Não foi possível listar warehouses e roles."));
    } finally {
      setOptionsBusy(false);
    }
  }

  const optionsLoaded = useRef(false);
  useEffect(() => {
    if (!optionsRequested || optionsLoaded.current) return;
    optionsLoaded.current = true;
    void loadOptions();
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Informe um nome para a conexão.");
      document.getElementById(`${idPrefix}-name`)?.focus();
      return;
    }
    if (!form.username.trim()) {
      setError("Informe o usuário Snowflake.");
      document.getElementById(`${idPrefix}-user`)?.focus();
      return;
    }
    const payload: Record<string, string> = {};
    if (changed.includes("name")) payload.name = form.name.trim();
    if (changed.includes("username")) payload.username = form.username.trim();
    if (changed.includes("role")) payload.role_name = form.role.trim();
    if (changed.includes("warehouse")) payload.warehouse = form.warehouse.trim();
    setBusy("connection");
    try {
      onDone(await editTokenConnection(token.id, payload));
    } catch (err) {
      setError(errorText(err, "Falha ao salvar os dados da conexão."));
    } finally {
      setBusy(null);
    }
  }

  const set = (key: keyof typeof original) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <form className="token-drawer-form" onSubmit={(e) => void submit(e)} autoComplete="off">
      <label htmlFor={`${idPrefix}-name`}>
        Nome da conexão
        <input id={`${idPrefix}-name`} value={form.name} onChange={set("name")} maxLength={200} />
      </label>
      <label htmlFor={`${idPrefix}-user`}>
        Usuário Snowflake
        <input
          id={`${idPrefix}-user`}
          value={form.username}
          onChange={set("username")}
          disabled={isOAuth}
          aria-describedby={isOAuth ? `${idPrefix}-user-hint` : undefined}
          spellCheck={false}
        />
      </label>
      {isOAuth ? (
        <p id={`${idPrefix}-user-hint`} className="token-drawer-help">
          O token OAuth é do usuário que fez login. Para trocar, use Reconectar via browser.
        </p>
      ) : null}
      <div className="token-drawer-grid">
        <label htmlFor={`${idPrefix}-role`}>
          Role
          <input
            id={`${idPrefix}-role`}
            value={form.role}
            onChange={set("role")}
            list={`${idPrefix}-roles`}
            placeholder="(padrão do usuário)"
            spellCheck={false}
          />
        </label>
        <label htmlFor={`${idPrefix}-wh`}>
          Warehouse
          <input
            id={`${idPrefix}-wh`}
            value={form.warehouse}
            onChange={set("warehouse")}
            list={`${idPrefix}-whs`}
            placeholder="(padrão do usuário)"
            spellCheck={false}
          />
        </label>
      </div>
      <datalist id={`${idPrefix}-roles`}>
        {(options?.roles || []).map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <datalist id={`${idPrefix}-whs`}>
        {(options?.warehouses || []).map((w) => (
          <option key={w.name} value={w.name}>
            {w.state ? `${w.name} (${w.state})` : w.name}
          </option>
        ))}
      </datalist>
      <div className="token-drawer-options" role="status">
        {optionsBusy ? (
          <span className="muted">Carregando roles e warehouses…</span>
        ) : optionsErr ? (
          <span className="token-drawer-options-err">{optionsErr} Digite os valores.</span>
        ) : options ? (
          <span className="muted">
            {options.roles.length} roles e {options.warehouses.length} warehouses sugeridos
            {options.fetched_at ? ` (lista de ${formatAbsolute(options.fetched_at)})` : ""}.
          </span>
        ) : null}
        <button
          type="button"
          className="btn ghost btn-inline"
          disabled={optionsBusy || busy !== null}
          onClick={() => void loadOptions(true)}
        >
          Atualizar lista
        </button>
      </div>
      <p className="token-drawer-help">
        Mudanças de usuário, role ou warehouse são testadas no Snowflake com a credencial salva
        antes de gravar. Trocar usuário ou role limpa o cache de dados desta conexão.
      </p>
      {error ? (
        <div className="error-box token-drawer-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row-actions">
        <button
          type="submit"
          className="btn primary"
          disabled={busy !== null || changed.length === 0}
          aria-busy={working}
        >
          {working
            ? identityChange
              ? "Testando no Snowflake…"
              : "Salvando…"
            : identityChange
              ? "Testar e salvar"
              : "Salvar"}
        </button>
        {changed.length ? (
          <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setForm(original)}>
            Desfazer
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ------------------------------------------------------------ Validade

const EXPIRY_PRESETS: Record<string, { days: number; label: string }[]> = {
  pat: [
    { days: 15, label: "+15 dias (padrão)" },
    { days: 90, label: "+90 dias" },
    { days: 365, label: "+365 dias (máx.)" },
  ],
  private_key: [
    { days: 90, label: "+90 dias" },
    { days: 365, label: "+1 ano" },
  ],
  oauth_refresh: [{ days: 90, label: "+90 dias (padrão)" }],
};

function ExpirySection({ token, busy, setBusy, onDone, now }: SectionProps & { now: number }) {
  const [value, setValue] = useState(() => toLocalInput(token.expires_at));
  const [error, setError] = useState<string | null>(null);
  const idPrefix = `tok-${token.id}-expiry`;
  const iso = fromLocalInput(value);
  const inPast = iso ? new Date(iso).getTime() <= now : false;
  const unchanged = value === toLocalInput(token.expires_at);

  useEffect(() => setValue(toLocalInput(token.expires_at)), [token.expires_at]);

  async function save(next: string | null) {
    setError(null);
    setBusy(next ? "expiry" : "expiry-clear");
    try {
      onDone(await setTokenExpiry(token.id, next));
    } catch (err) {
      setError(errorText(err, "Falha ao salvar a validade."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <form
      className="token-drawer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!iso) {
          setError("Escolha a data de validade.");
          document.getElementById(idPrefix)?.focus();
          return;
        }
        void save(iso);
      }}
    >
      <p className="token-drawer-help">
        O Snowflake não informa a validade deste tipo de credencial. Registre o vencimento para o
        portal marcar o token como Expirado e contar em “Expiram em 7 dias”. Valores manuais não são
        sobrescritos pela sincronização.
      </p>
      <label htmlFor={idPrefix}>
        Válido até
        <input
          id={idPrefix}
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={inPast ? `${idPrefix}-past` : undefined}
        />
      </label>
      <div className="token-drawer-chips" role="group" aria-label="Atalhos de validade">
        {(EXPIRY_PRESETS[token.token_type] || []).map((p) => (
          <button
            key={p.days}
            type="button"
            className="btn token-drawer-chip"
            onClick={() => setValue(daysFromNowInput(p.days))}
          >
            {p.label}
          </button>
        ))}
      </div>
      {inPast ? (
        <div id={`${idPrefix}-past`} className="warn-box token-drawer-box">
          A data está no passado: o token aparecerá como Expirado.
        </div>
      ) : null}
      {error ? (
        <div className="error-box token-drawer-box" role="alert">
          {error}
        </div>
      ) : null}
      <div className="row-actions">
        <button
          type="submit"
          className="btn primary"
          disabled={busy !== null || !iso || unchanged}
          aria-busy={busy === "expiry"}
        >
          {busy === "expiry" ? "Salvando…" : "Salvar validade"}
        </button>
        {token.expires_at ? (
          <button
            type="button"
            className="btn ghost"
            disabled={busy !== null}
            aria-busy={busy === "expiry-clear"}
            onClick={() => void save(null)}
          >
            {busy === "expiry-clear" ? "Removendo…" : "Remover validade"}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ------------------------------------------------------------ Confirmação

function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return (
    <div className="token-confirm-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="admin-modal token-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="token-confirm-title"
        aria-describedby="token-confirm-body"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-modal-head">
          <h2 id="token-confirm-title">{title}</h2>
        </div>
        <div id="token-confirm-body" className="token-confirm-body">
          {children}
        </div>
        {error ? (
          <div className="error-box token-drawer-box" role="alert">
            {error}
          </div>
        ) : null}
        <div className="admin-modal-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
          <button type="button" className="btn danger" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? "Aguarde…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const SNOWFLAKE_REVOKE_HINT: Record<string, ReactNode> = {
  pat: (
    <>
      Para invalidar no Snowflake: <code>ALTER USER … REMOVE PROGRAMMATIC ACCESS TOKEN &lt;nome&gt;;</code>
    </>
  ),
  private_key: (
    <>
      Para invalidar no Snowflake: <code>ALTER USER … UNSET RSA_PUBLIC_KEY;</code>
    </>
  ),
  password: <>Para invalidar no Snowflake, troque a senha do usuário lá.</>,
  oauth_access: <>No Snowflake, o access token só deixa de valer quando expira (cerca de 10 min).</>,
  oauth_refresh: <>No Snowflake, o refresh token vale até expirar ou até a integração OAuth ser revogada.</>,
};

// ------------------------------------------------------------ Drawer

export function TokenEditDrawer({ token, now, onClose, onChanged, onDeleted }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [confirm, setConfirm] = useState<"revoke" | "delete" | null>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [connOpened, setConnOpened] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const { actions } = token;
  const name = connectionLabel(token);
  const typeLabel = TYPE_LABELS[token.token_type];
  const isOAuth = token.token_type.startsWith("oauth_");
  const tone = expiryTone(token, now);
  const noSecret = Boolean(token.connection && !token.connection.has_secret);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    document.body.classList.add("modal-open");
    closeRef.current?.focus();
    return () => {
      document.body.classList.remove("modal-open");
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (busyRef.current) return;
        e.preventDefault();
        if (confirmRef.current) setConfirm(null);
        else onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const layer =
        panelRef.current.querySelector<HTMLElement>(".token-confirm") ?? panelRef.current;
      const items = [...layer.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!layer.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function done(res: TokenMutationResponse) {
    setNotice({ kind: "ok", text: res.message });
    onChanged(res.token);
  }

  async function runConfirm() {
    setConfirmErr(null);
    setBusy(confirm);
    try {
      if (confirm === "revoke") {
        const res = await revokeToken(token.id);
        setConfirm(null);
        done(res);
      } else if (confirm === "delete") {
        const res = await deleteTokenRecord(token.id);
        setConfirm(null);
        onDeleted(res.message);
      }
    } catch (err) {
      setConfirmErr(errorText(err, "A operação falhou."));
    } finally {
      setBusy(null);
    }
  }

  const sectionProps = {
    token,
    busy,
    setBusy,
    onDone: done,
  };
  const fixFirst = token.status !== "active";
  const hasEdits =
    actions.replace_secret ||
    actions.refresh ||
    actions.reconnect ||
    actions.edit_connection ||
    actions.set_expiry;

  return (
    <div className="token-drawer-root">
      <div className="token-drawer-backdrop" role="presentation" onClick={() => !busy && onClose()} />
      <aside
        ref={panelRef}
        className="token-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-drawer-title"
        aria-describedby="token-drawer-sub"
      >
        <header className="token-drawer-head">
          <div className="token-drawer-heading">
            <h2 id="token-drawer-title">Editar token</h2>
            <p id="token-drawer-sub" className="token-drawer-sub">
              {typeLabel} · {name}
            </p>
            <div className="token-drawer-badges">
              <span className={`admin-badge ${statusBadgeClass(token.status)}`}>
                {STATUS_LABELS[token.status]}
              </span>
              <span className="admin-badge is-support">{typeLabel}</span>
              {token.team_name ? <span className="admin-badge is-support">{token.team_name}</span> : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="btn admin-modal-close"
            onClick={onClose}
            disabled={busy !== null}
            aria-label="Fechar painel"
          >
            ×
          </button>
        </header>

        <div className="token-drawer-body">
          <div aria-live="polite" className="token-drawer-live">
            {notice ? (
              <div className={notice.kind === "ok" ? "success-box token-drawer-box" : "error-box token-drawer-box"}>
                {notice.text}
              </div>
            ) : null}
          </div>

          {noSecret ? (
            <div className="warn-box token-drawer-box">
              A conexão <strong>{name}</strong> está sem credencial: consultas e Cost Management
              falham até você {isOAuth ? "reconectar via browser" : "trocar o valor"}.
            </div>
          ) : null}
          {!token.connection_exists ? (
            <div className="info-box token-drawer-box">
              A conexão deste token foi removida. O registro fica só como histórico.
            </div>
          ) : null}

          <dl className="token-meta token-drawer-meta" aria-label="Detalhes do token">
            <dt>Conta</dt>
            <dd className="mono">{token.account_identifier || "—"}</dd>
            <dt>Usuário</dt>
            <dd>{token.connection?.username || token.username || "—"}</dd>
            <dt>Role</dt>
            <dd>{token.connection?.role_name || token.role_name || "—"}</dd>
            <dt>Warehouse</dt>
            <dd>{token.connection?.warehouse || "—"}</dd>
            <dt>Método</dt>
            <dd>{token.auth_method_label || token.auth_method || "—"}</dd>
            <dt>Emitido em</dt>
            <dd>{formatAbsolute(token.issued_at)}</dd>
            <dt>Expira em</dt>
            <dd>
              {token.expires_at ? (
                <>
                  <span className={`tokens-expiry-rel is-${tone}`}>
                    {formatRelative(token.expires_at, now)}
                  </span>{" "}
                  · {formatAbsolute(token.expires_at)}{" "}
                  <span className="muted">
                    ({token.expires_at_source === "manual" ? "informada manualmente" : "definida pelo Snowflake"})
                  </span>
                </>
              ) : (
                <span className="muted">{token.expiry_note || "—"}</span>
              )}
            </dd>
            <dt>{token.status === "revoked" ? "Revogado em" : "Última renovação"}</dt>
            <dd>{formatAbsolute(token.status === "revoked" ? token.revoked_at : token.last_refreshed_at)}</dd>
            <dt>Fingerprint</dt>
            <dd className="mono">{token.fingerprint_short ? `#${token.fingerprint_short}` : "—"}</dd>
            <dt>Origem</dt>
            <dd>
              {token.source ? SOURCE_LABELS[token.source] || token.source : "—"}
              {token.source_file ? ` (${token.source_file})` : ""}
            </dd>
            {token.file_name ? (
              <>
                <dt>Arquivo espelho</dt>
                <dd className="mono">{token.file_name}</dd>
              </>
            ) : null}
          </dl>

          {actions.replace_secret ? (
            <Section
              title="Trocar valor"
              hint={
                token.token_type === "password"
                  ? "Nova senha"
                  : token.token_type === "pat"
                    ? "Colar, arquivo da pasta ou upload"
                    : "Arquivo .p8 + passphrase"
              }
              defaultOpen={fixFirst}
            >
              <ReplaceSecretSection {...sectionProps} />
            </Section>
          ) : null}

          {actions.refresh || actions.reconnect ? (
            <Section
              title={actions.refresh ? "Renovar OAuth" : "Reconectar OAuth"}
              hint={actions.refresh ? "Renovar agora ou reconectar via browser" : "Login no Snowflake"}
              defaultOpen={fixFirst}
            >
              <OAuthSection {...sectionProps} />
            </Section>
          ) : null}

          {actions.edit_connection ? (
            <Section
              title="Dados da conexão"
              hint="Nome, usuário, role e warehouse"
              onOpen={() => setConnOpened(true)}
            >
              <ConnectionSection {...sectionProps} optionsRequested={connOpened} />
            </Section>
          ) : null}

          {actions.set_expiry ? (
            <Section
              title="Validade"
              hint={token.expires_at ? "Editar ou remover" : "Registrar vencimento"}
            >
              <ExpirySection {...sectionProps} now={now} />
            </Section>
          ) : null}

          {!hasEdits && !actions.delete && !actions.revoke ? (
            <p className="muted">Nenhuma ação disponível para este token.</p>
          ) : null}

          {actions.revoke || actions.delete ? (
            <section className="token-drawer-danger" aria-labelledby="token-danger-title">
              <h3 id="token-danger-title">Zona de perigo</h3>
              {actions.revoke ? (
                <div className="token-drawer-danger-row">
                  <p>
                    <strong>Revogar</strong> apaga {isOAuth ? "os tokens OAuth" : "o valor"} do portal.
                    {token.connection_exists ? " A conexão fica sem credencial." : ""}
                  </p>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmErr(null);
                      setConfirm("revoke");
                    }}
                  >
                    Revogar…
                  </button>
                </div>
              ) : null}
              {actions.delete ? (
                <div className="token-drawer-danger-row">
                  <p>
                    <strong>Excluir registro</strong> remove esta linha do histórico de tokens
                    revogados. Não afeta a conexão.
                  </p>
                  <button
                    type="button"
                    className="btn danger"
                    disabled={busy !== null}
                    onClick={() => {
                      setConfirmErr(null);
                      setConfirm("delete");
                    }}
                  >
                    Excluir registro…
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        {confirm === "revoke" ? (
          <ConfirmDialog
            title={`Revogar ${isOAuth ? "tokens OAuth" : typeLabel} de ${name}?`}
            confirmLabel={token.connection_exists ? "Revogar e desconectar" : "Revogar"}
            busy={busy === "revoke"}
            error={confirmErr}
            onConfirm={() => void runConfirm()}
            onCancel={() => !busy && setConfirm(null)}
          >
            {token.connection_exists ? (
              <>
                <p>
                  {isOAuth
                    ? "Os tokens OAuth access e refresh desta conexão são apagados juntos (são da mesma sessão de login)."
                    : `O valor criptografado (${typeLabel}) é apagado do portal.`}
                </p>
                <p>
                  A conexão <strong>{name}</strong> continua cadastrada, mas fica{" "}
                  <strong>sem credencial</strong>: consultas, Cost Management e alertas dela param
                  até você {isOAuth ? "reconectar via browser" : "trocar o valor"}.
                </p>
              </>
            ) : (
              <p>O valor criptografado é apagado; o registro fica no histórico.</p>
            )}
            <p className="muted">
              Isso não invalida o segredo no Snowflake. {SNOWFLAKE_REVOKE_HINT[token.token_type]}
            </p>
          </ConfirmDialog>
        ) : null}
        {confirm === "delete" ? (
          <ConfirmDialog
            title="Excluir registro do histórico?"
            confirmLabel="Excluir registro"
            busy={busy === "delete"}
            error={confirmErr}
            onConfirm={() => void runConfirm()}
            onCancel={() => !busy && setConfirm(null)}
          >
            <p>
              A linha {typeLabel} de <strong>{name}</strong> (revogada{" "}
              {formatAbsolute(token.revoked_at)}) sai da lista de revogados. Esta ação não pode ser
              desfeita.
            </p>
          </ConfirmDialog>
        ) : null}
      </aside>
    </div>
  );
}
