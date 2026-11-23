import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import {
  buildTokenPayload,
  emptyTokenChoice,
  type SavedToken,
  type SecretResult,
  type TokenChoice,
} from "../api/tokens";
import {
  CONN_INTERVAL_OPTIONS,
  globalIntervalHelp,
  intervalToSelectValue,
  selectValueToMinutes,
  type ConnIntervalValue,
} from "../connections/refreshIntervals";
import { revealServiceUserGuide, ServiceUserGuide } from "./ServiceUserGuide";
import { TokenSourceField } from "./TokenSourceField";

export type Conn = {
  id: number;
  name: string;
  account_identifier: string;
  username: string;
  auth_method: string;
  warehouse?: string | null;
  role_name?: string | null;
  refresh_interval?: number | null;
  team_name?: string;
};

type WarehouseOption = {
  name: string;
  state?: string | null;
  suggested?: boolean;
};

type SessionOptions = {
  warehouses: WarehouseOption[];
  roles: string[];
  suggested_warehouse?: string | null;
  stored_warehouse_exists?: boolean | null;
  warehouse_auto_saved?: string | null;
  hint?: string;
  cached?: boolean;
  fetched_at?: string | null;
};

type MethodDef = {
  key: string;
  label: string;
  title: string;
  desc: string;
};

const METHODS_RECOMMENDED: MethodDef[] = [
  {
    key: "browser_oauth",
    label: "Browser OAuth (como Cortex)",
    title: "Login via browser (recomendado)",
    desc:
      "Igual ao Local OAuth do Cortex: você autentica no Snowflake no browser e o portal guarda " +
      "o token OAuth. Não precisa de PAT, senha nem chave.",
  },
  {
    key: "pat",
    label: "Programmatic Access Token (PAT)",
    title: "Token de acesso programático",
    desc:
      "Reutilize um PAT já salvo no portal ou, na primeira conexão, selecione o arquivo ou cole " +
      "o token. Ele fica criptografado no banco.",
  },
  {
    key: "password",
    label: "Password",
    title: "Usuário e senha",
    desc: "Senha do usuário Snowflake, criptografada em repouso.",
  },
  {
    key: "keypair",
    label: "Key pair (RSA)",
    title: "Par de chaves RSA",
    desc:
      "Autentica com a chave privada (.p8) cuja chave pública está registrada no usuário " +
      "Snowflake (RSA_PUBLIC_KEY). Reutilize uma chave salva ou selecione o arquivo na primeira conexão.",
  },
];

const EDITABLE_METHODS = new Set(METHODS_RECOMMENDED.map((m) => m.key));

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function credentialPayload(
  method: string,
  patChoice: TokenChoice,
  keyChoice: TokenChoice,
  password: string,
  idPrefix: string,
): SecretResult {
  if (method === "pat") return buildTokenPayload("pat", patChoice, idPrefix);
  if (method === "keypair") return buildTokenPayload("keypair", keyChoice, idPrefix);
  if (method === "password") {
    return password.trim()
      ? { ok: true, payload: { secret: password, secret_source: "typed" } }
      : { ok: false, error: "Informe a senha do usuário Snowflake.", focusId: `${idPrefix}-password` };
  }
  return { ok: true, payload: {} };
}

function focusField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const target = el.tagName === "FIELDSET" ? el.querySelector<HTMLElement>("input, select") : el;
  target?.focus();
}

function warehouseOptionLabel(w: Pick<WarehouseOption, "name" | "state">): string {
  return w.state ? `${w.name} (${w.state})` : w.name;
}

function warehouseHeaderLabel(
  name: string | null | undefined,
  options: WarehouseOption[] | null | undefined,
  matchSelectLabel: boolean,
): string {
  const trimmed = name?.trim();
  if (!trimmed) return "(padrão da sessão / vazio)";
  if (!matchSelectLabel || !options?.length) return trimmed;
  const suggested = options.find((w) => w.suggested && w.name === trimmed);
  if (suggested) return warehouseOptionLabel(suggested);
  return `${trimmed} (atual / não sugerido)`;
}

type Props = {
  connection: Conn;
  teamId: number | "";
  globalIntervalSeconds: number;
  onClose: () => void;
  onSaved: (message: string) => void;
  onNotify: (message: string) => void;
  onReload: () => Promise<void>;
};

export function ConnectionEditModal({
  connection,
  teamId,
  globalIntervalSeconds,
  onClose,
  onSaved,
  onNotify,
  onReload,
}: Props) {
  const c = connection;
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const [editName, setEditName] = useState(c.name);
  const [editAccount, setEditAccount] = useState(c.account_identifier);
  const [editUser, setEditUser] = useState(c.username);
  const [editMethod, setEditMethod] = useState(() => {
    const m =
      c.auth_method === "oauth" || c.auth_method === "local_oauth"
        ? "browser_oauth"
        : c.auth_method;
    return EDITABLE_METHODS.has(m) ? m : "browser_oauth";
  });
  const [editSecret, setEditSecret] = useState("");
  const [editWarehouse, setEditWarehouse] = useState(c.warehouse || "");
  const [editRole, setEditRole] = useState(c.role_name || "");
  const [editInterval, setEditInterval] = useState<ConnIntervalValue>(() =>
    intervalToSelectValue(c.refresh_interval),
  );
  const [editOptions, setEditOptions] = useState<SessionOptions | null>(null);
  const [editOptionsErr, setEditOptionsErr] = useState<string | null>(null);
  const [editOptionsBusy, setEditOptionsBusy] = useState(false);
  const [editManualWh, setEditManualWh] = useState(false);
  const [editManualRole, setEditManualRole] = useState(false);
  const [editWhAutoReplaced, setEditWhAutoReplaced] = useState(false);
  const [editWhAutoSaved, setEditWhAutoSaved] = useState(false);
  const [editPatChoice, setEditPatChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [editKeyChoice, setEditKeyChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [editGuideOpen, setEditGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<"test" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  busyRef.current = busy;

  const editMethodMeta =
    METHODS_RECOMMENDED.find((m) => m.key === editMethod) ?? METHODS_RECOMMENDED[0];
  const keyNotRegistered = Boolean(err && err.includes("390144"));
  const keyFingerprint = keyNotRegistered
    ? (err?.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null)
    : null;

  function intervalPayload(): {
    refresh_interval?: number | null;
    clear_refresh_interval?: boolean;
  } {
    const minutes = selectValueToMinutes(editInterval);
    if (minutes == null) return { clear_refresh_interval: true };
    return { refresh_interval: minutes };
  }

  function applyEditTokenIdentity(t: SavedToken, force: boolean): boolean {
    let changed = false;
    if (t.account_identifier && (force || !editAccount.trim())) {
      setEditAccount(t.account_identifier);
      changed = true;
    }
    if (t.username && (force || !editUser.trim())) {
      setEditUser(t.username);
      changed = true;
    }
    return changed;
  }

  async function loadEditOptions(connectionId: number, refresh = false) {
    setEditOptionsBusy(true);
    setEditOptionsErr(null);
    setEditWhAutoSaved(false);
    try {
      const res = await api<SessionOptions & { ok?: boolean }>(
        `/api/connections/${connectionId}/options${refresh ? "?refresh=1" : ""}`,
      );
      setEditOptions(res);
      setEditManualWh(false);
      setEditManualRole(false);

      const autoSaved = (res.warehouse_auto_saved || "").trim();
      const suggested = (res.suggested_warehouse || "").trim();
      const needsHeal =
        Boolean(autoSaved) ||
        (!res.cached && res.stored_warehouse_exists === false && Boolean(suggested));

      if (needsHeal) {
        const next = autoSaved || suggested;
        setEditWarehouse(next);
        setEditWhAutoReplaced(true);

        if (autoSaved) {
          setEditWhAutoSaved(true);
          setMsg(`Warehouse inválido substituído e salvo: ${autoSaved}.`);
          await onReload();
        } else if (next) {
          try {
            await api<{ message: string; connection: Conn }>(
              `/api/connections/${connectionId}`,
              {
                method: "PATCH",
                body: JSON.stringify({ warehouse: next, revalidate: false }),
              },
            );
            setEditWhAutoSaved(true);
            setMsg(`Warehouse inválido substituído e salvo: ${next}.`);
            await onReload();
          } catch {
            setEditWhAutoSaved(false);
            setMsg(
              `Warehouse sugerido: ${next}. Clique em Salvar WH / Role para gravar.`,
            );
          }
        }
      } else {
        setEditWhAutoReplaced(false);
        setEditWhAutoSaved(false);
      }
    } catch (e) {
      setEditOptions(null);
      setEditOptionsErr(
        e instanceof ApiError
          ? e.message
          : "Não foi possível listar warehouses/roles. Digite manualmente.",
      );
      setEditManualWh(true);
      setEditManualRole(true);
    } finally {
      setEditOptionsBusy(false);
    }
  }

  useEffect(() => {
    void loadEditOptions(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once per connection
  }, [c.id]);

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
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!panelRef.current.contains(document.activeElement)) {
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

  async function saveEditMeta() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await api<{ message: string; connection: Conn }>(`/api/connections/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim() || undefined,
          account_identifier: editAccount.trim(),
          username: editUser.trim(),
          warehouse: editWarehouse,
          role_name: editRole,
          clear_warehouse: !editWarehouse.trim(),
          clear_role: !editRole.trim(),
          ...intervalPayload(),
          revalidate: false,
        }),
      });
      onSaved(res.message || "Warehouse/role salvos.");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao salvar warehouse/role.");
    } finally {
      setBusy(false);
    }
  }

  async function reconnectEditOAuth() {
    if (!editAccount.trim() || !editUser.trim()) {
      setErr("Preencha Account Identifier e Username.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const minutes = selectValueToMinutes(editInterval);
      const res = await api<{ authorize_url: string }>("/api/connections/oauth/start", {
        method: "POST",
        body: JSON.stringify({
          connection_id: c.id,
          account_identifier: editAccount.trim(),
          username: editUser.trim(),
          name: editName.trim() || null,
          warehouse: editWarehouse.trim() || null,
          role_name: editRole.trim() || null,
          refresh_interval: minutes,
          team_id: teamId === "" ? null : Number(teamId),
        }),
      });
      onNotify("Reconectando via browser…");
      window.location.href = res.authorize_url;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao iniciar OAuth.");
      setBusy(false);
    }
  }

  async function saveEdit(testOnly: boolean) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    if (editMethod === "browser_oauth") {
      await reconnectEditOAuth();
      return;
    }
    const cred = credentialPayload(
      editMethod,
      editPatChoice,
      editKeyChoice,
      editSecret || secretRef.current?.value || "",
      `edit-${c.id}`,
    );
    if (!cred.ok) {
      setErr(cred.error);
      setBusy(false);
      focusField(cred.focusId);
      return;
    }
    setBusyAction(testOnly ? "test" : "save");
    const payload = {
      name: editName.trim() || undefined,
      account_identifier: editAccount.trim(),
      username: editUser.trim(),
      auth_method: editMethod,
      ...cred.payload,
      warehouse: editWarehouse,
      role_name: editRole,
      clear_warehouse: !editWarehouse.trim(),
      clear_role: !editRole.trim(),
      ...intervalPayload(),
      revalidate: true,
    };
    try {
      if (testOnly) {
        const res = await api<{ message: string }>("/api/connections/test", {
          method: "POST",
          body: JSON.stringify({
            account_identifier: payload.account_identifier,
            username: payload.username,
            auth_method: payload.auth_method,
            ...cred.payload,
            warehouse: editWarehouse.trim() || null,
            role_name: editRole.trim() || null,
          }),
        });
        setMsg(res.message);
      } else {
        const res = await api<{ message: string; connection: Conn }>(`/api/connections/${c.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        onSaved(res.message || "Conexão atualizada e autenticada.");
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao editar/revalidar conexão.");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  const intervalHelp: ReactNode =
    editInterval === "global" ? (
      <>
        <em>Global</em> segue o intervalo da barra em Contas salvas (
        {globalIntervalHelp(globalIntervalSeconds)}). Se a Global estiver Desligada, esta conexão
        não atualiza automaticamente.
      </>
    ) : (
      <>
        Esta conexão atualiza a cada <em>{editInterval} min</em>, independente do controle Global da
        lista.
      </>
    );

  return (
    <div className="conn-modal-root">
      <div
        className="conn-modal-backdrop"
        role="presentation"
        onClick={() => !busy && onClose()}
      />
      <div
        ref={panelRef}
        className="conn-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conn-modal-title"
        aria-describedby="conn-modal-sub"
      >
        <header className="conn-modal-header">
          <div>
            <h2 id="conn-modal-title">Editar conexão</h2>
            <p id="conn-modal-sub" className="conn-modal-sub">
              Altere os dados e o intervalo de atualização.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="conn-modal-close"
            aria-label="Fechar"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="conn-modal-body">
          <div className="form-stack conn-modal-form">
            <div className="info-box">
              Revalide como um cadastro novo: altere os campos e autentique de novo. Ao trocar o
              método, só os campos de credencial mudam.
            </div>
            <label>
              Método de autenticação
              <select
                value={editMethod}
                onChange={(e) => {
                  setEditMethod(e.target.value);
                  setErr(null);
                }}
                aria-describedby={`edit-${c.id}-method-desc`}
              >
                {METHODS_RECOMMENDED.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="info-box method-desc" style={{ margin: 0 }}>
              <div id={`edit-${c.id}-method-desc`} aria-live="polite">
                <strong>{editMethodMeta.title}</strong>
                {editMethodMeta.desc}
              </div>
              <ServiceUserGuide
                id={`edit-${c.id}-sf-guide`}
                method={editMethod}
                username={editUser}
                role={editRole}
                fingerprint={keyFingerprint}
                open={editGuideOpen}
                onOpenChange={setEditGuideOpen}
              />
            </div>
            <label>
              Conta (Account Identifier) *
              <input
                value={editAccount}
                onChange={(e) => setEditAccount(e.target.value)}
                required
              />
            </label>
            <label>
              Nome da conexão
              <input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <label>
              Usuário *
              <input value={editUser} onChange={(e) => setEditUser(e.target.value)} required />
            </label>
            {editMethod === "pat" || editMethod === "keypair" ? (
              <TokenSourceField
                key={`${c.id}-${editMethod}`}
                idPrefix={`edit-${c.id}`}
                kind={editMethod}
                value={editMethod === "pat" ? editPatChoice : editKeyChoice}
                onChange={editMethod === "pat" ? setEditPatChoice : setEditKeyChoice}
                account={editAccount}
                username={editUser}
                onUseTokenIdentity={applyEditTokenIdentity}
                currentConnectionId={c.id}
              />
            ) : editMethod === "password" ? (
              <label htmlFor={`edit-${c.id}-password`}>
                Senha *
                <input
                  id={`edit-${c.id}-password`}
                  ref={secretRef}
                  type="password"
                  value={editSecret}
                  onChange={(e) => setEditSecret(e.target.value)}
                  placeholder="Obrigatória para revalidar"
                  autoComplete="current-password"
                  required
                />
              </label>
            ) : (
              <div className="warn-box">
                Browser OAuth: ao salvar, o login Snowflake abre no browser e substitui o token
                desta conexão.
              </div>
            )}
            <label>
              Warehouse (vazio = auto / evita WH com cota estourada)
              {editManualWh || !editOptions?.warehouses?.length ? (
                <input
                  value={editWarehouse}
                  onChange={(e) => {
                    setEditWarehouse(e.target.value);
                    setEditWhAutoReplaced(false);
                  }}
                  placeholder="WH_CON_EXT ou vazio (auto)"
                  list="edit-wh-suggestions"
                />
              ) : (
                <select
                  value={editWarehouse}
                  onChange={(e) => {
                    setEditWarehouse(e.target.value);
                    setEditWhAutoReplaced(false);
                  }}
                >
                  <option value="">(auto — escolher WH disponível)</option>
                  {editOptions.warehouses
                    .filter((w) => w.suggested)
                    .map((w) => (
                      <option key={w.name} value={w.name}>
                        {warehouseOptionLabel(w)}
                      </option>
                    ))}
                  {editWarehouse &&
                  !editOptions.warehouses.some(
                    (w) => w.suggested && w.name === editWarehouse,
                  ) ? (
                    <option value={editWarehouse}>
                      {warehouseHeaderLabel(editWarehouse, editOptions.warehouses, true)}
                    </option>
                  ) : null}
                </select>
              )}
            </label>
            <datalist id="edit-wh-suggestions">
              {(editOptions?.warehouses || [])
                .filter((w) => w.suggested)
                .map((w) => (
                  <option key={w.name} value={w.name} />
                ))}
            </datalist>
            <label>
              Role
              {editManualRole || !editOptions?.roles?.length ? (
                <input
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  placeholder="ACCOUNTADMIN"
                  list="edit-role-suggestions"
                />
              ) : (
                <select value={editRole} onChange={(e) => setEditRole(e.target.value)}>
                  <option value="">(padrão da sessão)</option>
                  {editOptions.roles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                  {editRole && !editOptions.roles.includes(editRole) ? (
                    <option value={editRole}>{editRole} (atual)</option>
                  ) : null}
                </select>
              )}
            </label>
            <datalist id="edit-role-suggestions">
              {(editOptions?.roles || []).map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <label>
              Intervalo de atualização
              <select
                value={editInterval}
                onChange={(e) => setEditInterval(e.target.value as ConnIntervalValue)}
              >
                {CONN_INTERVAL_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="field-help">{intervalHelp}</span>
            </label>
            <div className="row-actions" style={{ marginTop: "-0.25rem" }}>
              <button
                type="button"
                className="btn"
                disabled={editOptionsBusy || busy}
                onClick={() => void loadEditOptions(c.id, true)}
              >
                {editOptionsBusy ? "Atualizando…" : "Atualizar WH / Roles"}
              </button>
              {editOptions?.fetched_at ? (
                <span className="muted" style={{ alignSelf: "center", fontSize: "0.8rem" }}>
                  Atualizado em{" "}
                  {new Date(editOptions.fetched_at).toLocaleString("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
              ) : null}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditManualWh((v) => !v);
                  setEditManualRole((v) => !v);
                }}
              >
                {editManualWh ? "Usar lista" : "Digitar manualmente"}
              </button>
            </div>
            {editOptionsErr ? <div className="warn-box">{editOptionsErr}</div> : null}
            {editOptions?.hint ? (
              <p className="muted" style={{ margin: 0 }}>
                {editOptions.hint}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Prefira WH_CON_EXT. Se o monitor MONITORAMENTO_EMPRESA estiver sem cota (090073),
                trocar o WH não resolve — aumente a cota ou aguarde o reset mensal.
              </p>
            )}
            {editWhAutoReplaced ? (
              <div className={editWhAutoSaved ? "success-box" : "warn-box"}>
                {editWhAutoSaved ? (
                  <>
                    O warehouse salvo não existia mais nesta conta. Foi substituído e gravado
                    automaticamente como <strong>{editWarehouse || "(auto)"}</strong> — Cost
                    Management já usa este valor.
                  </>
                ) : (
                  <>
                    O warehouse salvo na conexão não existe mais nesta conta. A lista selecionou{" "}
                    <strong>{editWarehouse || "(auto)"}</strong> — clique em{" "}
                    <strong>Salvar WH / Role</strong> para gravar (Cost Management usa o valor
                    salvo).
                  </>
                )}
              </div>
            ) : null}
            {err ? (
              <div className="error-box" role="alert" style={{ margin: 0 }}>
                {err}
                {keyNotRegistered && editMethod === "keypair" ? (
                  <div className="row-actions" style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn"
                      aria-controls={`edit-${c.id}-sf-guide`}
                      onClick={() =>
                        revealServiceUserGuide(`edit-${c.id}-sf-guide`, setEditGuideOpen)
                      }
                    >
                      Como registrar a chave no Snowflake
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {msg ? (
              <div className="success-box" role="status" style={{ margin: 0 }}>
                {msg}
              </div>
            ) : null}
            <p className="muted" style={{ margin: 0 }}>
              Depois de autenticar, abra <Link to="/cost-management">Cost Management</Link>.
            </p>
          </div>
        </div>

        <footer className="conn-modal-footer">
          {editMethod === "browser_oauth" ? (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() => void saveEditMeta()}
              >
                Salvar WH / Role
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void saveEdit(false)}
              >
                Reconectar via browser
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-busy={busyAction === "test"}
                onClick={() => void saveEdit(true)}
              >
                {busyAction === "test" ? "Testando…" : "Testar conexão"}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                aria-busy={busyAction === "save"}
                onClick={() => void saveEdit(false)}
              >
                {busyAction === "save" ? "Salvando…" : "Salvar e revalidar"}
              </button>
            </>
          )}
          <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
        </footer>
      </div>
    </div>
  );
}
