import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, setActiveConnectionId } from "../api/client";
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
  selectValueToMinutes,
  type ConnIntervalValue,
} from "../connections/refreshIntervals";
import { revealServiceUserGuide, ServiceUserGuide } from "./ServiceUserGuide";
import { TokenSourceField } from "./TokenSourceField";
import type { Conn } from "./ConnectionEditModal";

type Team = { id: number; name: string };

type WarehouseOption = {
  name: string;
  state?: string | null;
  suggested?: boolean;
};

type SessionOptions = {
  warehouses: WarehouseOption[];
  roles: string[];
  suggested_warehouse?: string | null;
  hint?: string;
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

type Props = {
  teams: Team[];
  teamId: number | "";
  onTeamIdChange: (id: number | "") => void;
  globalIntervalSeconds: number;
  onClose: () => void;
  onCreated: (connection: Conn, message: string) => void;
  onNotify: (message: string) => void;
  /** Prefill error from OAuth return while modal reopens. */
  initialError?: string | null;
};

export function ConnectionCreateModal({
  teams,
  teamId,
  onTeamIdChange,
  globalIntervalSeconds,
  onClose,
  onCreated,
  onNotify,
  initialError = null,
}: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const secretRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const optionsKeyRef = useRef<string | null>(null);

  const [method, setMethod] = useState("browser_oauth");
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [sfUser, setSfUser] = useState("");
  const [secret, setSecret] = useState("");
  const [patChoice, setPatChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [keyChoice, setKeyChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [warehouse, setWarehouse] = useState("");
  const [roleName, setRoleName] = useState("");
  const [interval, setInterval] = useState<ConnIntervalValue>("global");
  const [options, setOptions] = useState<SessionOptions | null>(null);
  const [optionsErr, setOptionsErr] = useState<string | null>(null);
  const [optionsBusy, setOptionsBusy] = useState(false);
  const [manualWh, setManualWh] = useState(false);
  const [manualRole, setManualRole] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<"test" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(initialError);
  const [msg, setMsg] = useState<string | null>(null);

  busyRef.current = busy;
  const methodMeta = METHODS_RECOMMENDED.find((m) => m.key === method)!;
  const keyNotRegistered = Boolean(err && err.includes("390144"));
  const keyFingerprint = keyNotRegistered
    ? (err?.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null)
    : null;

  function identityKey(): string {
    return [account, sfUser, roleName].map((v) => v.trim().toLowerCase()).join("|");
  }

  function applyTokenIdentity(t: SavedToken, force: boolean): boolean {
    let changed = false;
    if (t.account_identifier && (force || !account.trim())) {
      setAccount(t.account_identifier);
      changed = true;
    }
    if (t.username && (force || !sfUser.trim())) {
      setSfUser(t.username);
      changed = true;
    }
    return changed;
  }

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

  async function loadOptions() {
    setOptionsBusy(true);
    setOptionsErr(null);
    if (method === "browser_oauth") {
      setOptionsErr(
        "Após Conectar via browser, abra Editar na conexão salva para listar warehouses e roles.",
      );
      setOptionsBusy(false);
      return;
    }
    if (!account.trim() || !sfUser.trim()) {
      setOptionsErr("Preencha conta e usuário para listar warehouses e roles.");
      setOptionsBusy(false);
      return;
    }
    const cred = credentialPayload(
      method,
      patChoice,
      keyChoice,
      secret || secretRef.current?.value || "",
      "create",
    );
    if (!cred.ok) {
      setOptionsErr(cred.error);
      setOptionsBusy(false);
      focusField(cred.focusId);
      return;
    }
    try {
      const res = await api<SessionOptions & { ok?: boolean }>("/api/connections/discover", {
        method: "POST",
        body: JSON.stringify({
          account_identifier: account.trim(),
          username: sfUser.trim(),
          auth_method: method,
          ...cred.payload,
          warehouse: warehouse.trim() || null,
          role_name: roleName.trim() || null,
        }),
      });
      setOptions(res);
      optionsKeyRef.current = identityKey();
      setManualWh(false);
      setManualRole(false);
      if (!warehouse.trim() && res.suggested_warehouse) {
        setWarehouse(res.suggested_warehouse);
      }
    } catch (e) {
      setOptions(null);
      setOptionsErr(
        e instanceof ApiError
          ? e.message
          : "Falha ao listar warehouses/roles. Digite manualmente.",
      );
      setManualWh(true);
      setManualRole(true);
    } finally {
      setOptionsBusy(false);
    }
  }

  async function startOAuth() {
    setErr(null);
    setMsg(null);
    if (!account.trim() || !sfUser.trim()) {
      setErr("Preencha Account Identifier e Username antes do login via browser.");
      return;
    }
    setBusy(true);
    try {
      const minutes = selectValueToMinutes(interval);
      const res = await api<{ authorize_url: string }>("/api/connections/oauth/start", {
        method: "POST",
        body: JSON.stringify({
          account_identifier: account.trim(),
          username: sfUser.trim(),
          name: name || null,
          warehouse: warehouse || null,
          role_name: roleName || null,
          refresh_interval: minutes,
          team_id: teamId === "" ? null : Number(teamId),
        }),
      });
      onNotify("Redirecionando para o login Snowflake no browser…");
      window.location.href = res.authorize_url;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao iniciar OAuth.");
      setBusy(false);
    }
  }

  async function submit(testOnly: boolean) {
    setErr(null);
    setMsg(null);
    if (method === "browser_oauth") {
      await startOAuth();
      return;
    }
    const cred = credentialPayload(
      method,
      patChoice,
      keyChoice,
      secret || secretRef.current?.value || "",
      "create",
    );
    if (!cred.ok) {
      setErr(cred.error);
      focusField(cred.focusId);
      return;
    }
    setBusy(true);
    setBusyAction(testOnly ? "test" : "save");
    const minutes = selectValueToMinutes(interval);
    const payload = {
      account_identifier: account,
      username: sfUser,
      auth_method: method,
      ...cred.payload,
      warehouse: warehouse || null,
      role_name: roleName || null,
      refresh_interval: minutes,
      name: name || null,
      team_id: teamId === "" ? null : Number(teamId),
    };
    try {
      if (testOnly) {
        const res = await api<{ message: string }>("/api/connections/test", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setMsg(res.message);
      } else {
        const cached =
          options && optionsKeyRef.current === identityKey() ? options : null;
        const res = await api<{ message: string; connection: Conn }>("/api/connections", {
          method: "POST",
          body: JSON.stringify({ ...payload, options: cached }),
        });
        setActiveConnectionId(res.connection.id);
        onCreated(res.connection, res.message);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha na conexão.");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  const intervalHelp: ReactNode =
    interval === "global" ? (
      <>
        <em>Global</em> segue o intervalo da barra em Contas salvas (
        {globalIntervalHelp(globalIntervalSeconds)}). Se a Global estiver Desligada, esta conexão
        não atualiza automaticamente.
      </>
    ) : (
      <>
        Esta conexão atualizará a cada <em>{interval} min</em>.
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
        aria-labelledby="conn-create-title"
        aria-describedby="conn-create-sub"
      >
        <header className="conn-modal-header">
          <div>
            <h2 id="conn-create-title">Nova conexão</h2>
            <p id="conn-create-sub" className="conn-modal-sub">
              Preencha os dados e escolha o intervalo de atualização.
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
          <form
            className="form-stack conn-modal-form"
            autoComplete="off"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            <label htmlFor="create-method">
              Método de autenticação
              <select
                id="create-method"
                value={method}
                onChange={(e) => {
                  setMethod(e.target.value);
                  setErr(null);
                  setMsg(null);
                  setOptionsErr(null);
                }}
                aria-describedby="create-method-desc"
              >
                {METHODS_RECOMMENDED.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="info-box method-desc" style={{ margin: 0 }}>
              <div id="create-method-desc" aria-live="polite">
                <strong>{methodMeta.title}</strong>
                {methodMeta.desc}
              </div>
              <ServiceUserGuide
                id="create-sf-guide"
                method={method}
                username={sfUser}
                role={roleName}
                fingerprint={keyFingerprint}
                open={guideOpen}
                onOpenChange={setGuideOpen}
              />
            </div>

            <label>
              Conta (Account Identifier) *
              <input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                placeholder="ORG-ACCOUNT ou conta.regiao"
                autoComplete="off"
                required
              />
            </label>
            <label>
              Nome da conexão
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome amigável da conta"
                autoComplete="off"
              />
            </label>
            <label>
              Usuário *
              <input
                value={sfUser}
                onChange={(e) => setSfUser(e.target.value)}
                placeholder="Usuário Snowflake"
                autoComplete="username"
                required
              />
            </label>

            {method === "pat" || method === "keypair" ? (
              <TokenSourceField
                key={method}
                idPrefix="create"
                kind={method}
                value={method === "pat" ? patChoice : keyChoice}
                onChange={method === "pat" ? setPatChoice : setKeyChoice}
                account={account}
                username={sfUser}
                onUseTokenIdentity={applyTokenIdentity}
              />
            ) : null}
            {method === "password" ? (
              <label htmlFor="create-password">
                Senha *
                <input
                  id="create-password"
                  ref={secretRef}
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            ) : null}

            <details open>
              <summary>Optional Settings (Warehouse / Role)</summary>
              <label>
                Warehouse
                {manualWh || !options?.warehouses?.length ? (
                  <input
                    value={warehouse}
                    onChange={(e) => setWarehouse(e.target.value)}
                    placeholder="WH_CON_EXT ou vazio (auto)"
                    list="create-wh-suggestions"
                  />
                ) : (
                  <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                    <option value="">(auto — escolher WH disponível)</option>
                    {options.warehouses
                      .filter((w) => w.suggested)
                      .map((w) => (
                        <option key={w.name} value={w.name}>
                          {warehouseOptionLabel(w)}
                        </option>
                      ))}
                  </select>
                )}
              </label>
              <datalist id="create-wh-suggestions">
                {(options?.warehouses || [])
                  .filter((w) => w.suggested)
                  .map((w) => (
                    <option key={w.name} value={w.name} />
                  ))}
              </datalist>
              <label>
                Role
                {manualRole || !options?.roles?.length ? (
                  <input
                    value={roleName}
                    onChange={(e) => setRoleName(e.target.value)}
                    placeholder="ACCOUNTADMIN"
                    list="create-role-suggestions"
                  />
                ) : (
                  <select value={roleName} onChange={(e) => setRoleName(e.target.value)}>
                    <option value="">(padrão da sessão)</option>
                    {options.roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <datalist id="create-role-suggestions">
                {(options?.roles || []).map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
              <div className="row-actions">
                {method === "browser_oauth" ? (
                  <p className="muted" style={{ margin: 0, alignSelf: "center", fontSize: "0.85rem" }}>
                    Com Browser OAuth, a lista de warehouses e roles aparece em Editar após o login.
                  </p>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={optionsBusy || busy}
                    aria-busy={optionsBusy}
                    onClick={() => void loadOptions()}
                  >
                    {optionsBusy ? "Listando…" : "Listar WH / Roles da conta"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setManualWh((v) => !v);
                    setManualRole((v) => !v);
                  }}
                >
                  {manualWh ? "Usar lista" : "Digitar manualmente"}
                </button>
              </div>
              {optionsErr ? <div className="warn-box">{optionsErr}</div> : null}
              {options?.hint ? (
                <p className="muted" style={{ margin: 0 }}>
                  {options.hint}
                </p>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Prefira WH_CON_EXT. WH_ANALISTA / SYSTEM$* podem falhar por cota do monitor
                  MONITORAMENTO_EMPRESA (090073).
                </p>
              )}
            </details>

            <label>
              Intervalo de atualização
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value as ConnIntervalValue)}
              >
                {CONN_INTERVAL_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="field-help">{intervalHelp}</span>
            </label>

            <label>
              Time (ACL)
              <select
                value={teamId}
                onChange={(e) =>
                  onTeamIdChange(e.target.value ? Number(e.target.value) : "")
                }
              >
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>

            {err ? (
              <div className="error-box" role="alert" style={{ margin: 0 }}>
                {err}
                {keyNotRegistered && method === "keypair" ? (
                  <div className="row-actions" style={{ marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      className="btn"
                      aria-controls="create-sf-guide"
                      onClick={() => revealServiceUserGuide("create-sf-guide", setGuideOpen)}
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
          </form>
        </div>

        <footer className="conn-modal-footer">
          {method === "browser_oauth" ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void submit(false)}
            >
              Conectar via browser
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={busy}
                aria-busy={busyAction === "test"}
                onClick={() => void submit(true)}
              >
                {busyAction === "test" ? "Testando…" : "Testar conexão"}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                aria-busy={busyAction === "save"}
                onClick={() => void submit(false)}
              >
                {busyAction === "save" ? "Salvando…" : "Sign In / Salvar"}
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
