import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, setActiveConnectionId, getActiveConnectionId } from "../api/client";
import {
  buildTokenPayload,
  emptyTokenChoice,
  type SavedToken,
  type SecretResult,
  type TokenChoice,
} from "../api/tokens";
import { useAuth } from "../auth/AuthContext";
import { revealServiceUserGuide, ServiceUserGuide } from "../components/ServiceUserGuide";
import { TokenSourceField } from "../components/TokenSourceField";
import { useRefresh } from "../refresh/RefreshContext";

type Conn = {
  id: number;
  name: string;
  account_identifier: string;
  username: string;
  auth_method: string;
  warehouse?: string | null;
  role_name?: string | null;
  team_name?: string;
};

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
  stored_warehouse_exists?: boolean | null;
  /** Set when API auto-persisted a replacement for a missing stored WH. */
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

/** Credential fields for the API, or the validation error to show (and field to focus). */
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

const ALL_METHODS = METHODS_RECOMMENDED;

const METHOD_LABELS: Record<string, string> = {
  ...Object.fromEntries(ALL_METHODS.map((m) => [m.key, m.label])),
  oauth: "Browser OAuth (como Cortex)",
  local_oauth: "Browser OAuth (como Cortex)",
  sso: "External Browser (SSO)",
};

/** Label text for a WH option (name + optional Snowflake state). Value stays name-only. */
function warehouseOptionLabel(w: Pick<WarehouseOption, "name" | "state">): string {
  return w.state ? `${w.name} (${w.state})` : w.name;
}

/**
 * Header `WH: …` must match the selected <option> label when the edit dropdown is active.
 * Persist/compare still use the bare warehouse name (`editWarehouse`).
 */
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

  // Same fallback as the edit <select> when saved WH is missing from suggested list
  return `${trimmed} (atual / não sugerido)`;
}

export function ConnectionsPage() {
  const { user } = useAuth();
  const secretRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"hub" | "signin">("hub");
  const [connections, setConnections] = useState<Conn[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [activeId, setActiveId] = useState<number | null>(getActiveConnectionId());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editAccount, setEditAccount] = useState("");
  const [editUser, setEditUser] = useState("");
  const [editMethod, setEditMethod] = useState("browser_oauth");
  const [editSecret, setEditSecret] = useState("");
  const [editWarehouse, setEditWarehouse] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editOptions, setEditOptions] = useState<SessionOptions | null>(null);
  const [editOptionsErr, setEditOptionsErr] = useState<string | null>(null);
  const [editOptionsBusy, setEditOptionsBusy] = useState(false);
  const [editManualWh, setEditManualWh] = useState(false);
  const [editManualRole, setEditManualRole] = useState(false);
  /** True when options loader replaced a missing/invalid saved WH with a suggested one. */
  const [editWhAutoReplaced, setEditWhAutoReplaced] = useState(false);
  /** True when the replacement was persisted automatically (no Salvar needed). */
  const [editWhAutoSaved, setEditWhAutoSaved] = useState(false);
  const editSecretRef = useRef<HTMLInputElement>(null);
  const [editPatChoice, setEditPatChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [editKeyChoice, setEditKeyChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [method, setMethod] = useState("browser_oauth");
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [sfUser, setSfUser] = useState("");
  const [secret, setSecret] = useState("");
  // One choice per method so switching PAT ⇄ Key pair keeps what was picked for each.
  const [patChoice, setPatChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [keyChoice, setKeyChoice] = useState<TokenChoice>(emptyTokenChoice);
  const [warehouse, setWarehouse] = useState("");
  const [roleName, setRoleName] = useState("");
  const [signinOptions, setSigninOptions] = useState<SessionOptions | null>(null);
  const [signinOptionsErr, setSigninOptionsErr] = useState<string | null>(null);
  const [signinOptionsBusy, setSigninOptionsBusy] = useState(false);
  /** Account/user/role the listed signinOptions belong to; only then are they sent on save. */
  const signinOptionsKeyRef = useRef<string | null>(null);
  const [signinManualWh, setSigninManualWh] = useState(false);
  const [signinManualRole, setSigninManualRole] = useState(false);
  const [teamId, setTeamId] = useState<number | "">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<"test" | "save" | null>(null);
  const [signinGuideOpen, setSigninGuideOpen] = useState(false);
  const [editGuideOpen, setEditGuideOpen] = useState(false);

  const { refreshToken } = useRefresh();

  async function reload() {
    const list = await api<Conn[]>("/api/connections");
    setConnections(list);
  }

  // Global refresh re-fetched the active account: pick up a healed WH and fresh WH/roles.
  useEffect(() => {
    if (refreshToken === 0) return;
    void reload().catch(() => undefined);
    if (editingId != null && editingId === getActiveConnectionId()) {
      void loadEditOptions(editingId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on global refresh
  }, [refreshToken]);

  useEffect(() => {
    void reload().catch(() => setConnections([]));
    void api<Team[]>("/api/teams")
      .then((t) => {
        setTeams(t);
        if (t.length) setTeamId(t[0].id);
      })
      .catch(() => setTeams([]));
  }, []);

  // Deep-link from Cost Management: /conexoes?edit=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const editRaw = params.get("edit");
    if (!editRaw || !connections.length) return;
    const editId = Number(editRaw);
    if (!editId) return;
    const target = connections.find((c) => c.id === editId);
    if (!target) return;
    setTab("hub");
    startEdit(target);
    window.history.replaceState({}, "", "/conexoes");
  }, [connections]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get("oauth");
    if (!oauth) return;
    if (oauth === "ok") {
      const id = Number(params.get("connection_id") || "");
      setTab("hub");
      setBusy(false);
      setMsg(
        id
          ? "Login Snowflake via browser concluído. Conexão atualizada e autenticada."
          : "Login Snowflake via browser concluído. Conexão salva e pronta para uso.",
      );
      setErr(null);
      void reload().then(() => {
        if (id) {
          setActiveConnectionId(id);
          setActiveId(id);
          // Open edit + refresh WH/role lists from the live account
          void api<Conn[]>("/api/connections").then((list) => {
            const target = list.find((c) => c.id === id);
            if (target) startEdit(target);
          });
        }
      });
    } else if (oauth === "error") {
      setTab("signin");
      setMethod("browser_oauth");
      setBusy(false);
      const detail = params.get("detail") || "Falha no OAuth via browser.";
      try {
        setErr(decodeURIComponent(detail));
      } catch {
        setErr(detail);
      }
    }
    window.history.replaceState({}, "", "/conexoes");
  }, []);

  async function activate(id: number) {
    await api(`/api/connections/${id}/activate`, { method: "POST" });
    setActiveConnectionId(id);
    setActiveId(id);
    setMsg("Conexão ativada.");
  }

  function inactivate() {
    setActiveConnectionId(null);
    setActiveId(null);
    setMsg("Conexão inativada. Cost Management exige uma conta ativa.");
  }

  function signinIdentityKey(): string {
    return [account, sfUser, roleName].map((v) => v.trim().toLowerCase()).join("|");
  }

  function applySigninTokenIdentity(t: SavedToken, force: boolean): boolean {
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

  /** Blank Sign in / Nova conexão form — never copy a saved connection. */
  function resetSigninForm() {
    signinOptionsKeyRef.current = null;
    setMethod("browser_oauth");
    setAccount("");
    setName("");
    setSfUser("");
    setSecret("");
    setPatChoice(emptyTokenChoice());
    setKeyChoice(emptyTokenChoice());
    setWarehouse("");
    setRoleName("");
    setSigninOptions(null);
    setSigninOptionsErr(null);
    setSigninOptionsBusy(false);
    setSigninManualWh(false);
    setSigninManualRole(false);
    setErr(null);
    setMsg(null);
    setEditingId(null);
  }

  function openNewConnection() {
    resetSigninForm();
    setTab("signin");
  }

  function startEdit(c: Conn) {
    setEditingId(c.id);
    setEditName(c.name);
    setEditAccount(c.account_identifier);
    setEditUser(c.username);
    const m = c.auth_method === "oauth" || c.auth_method === "local_oauth" ? "browser_oauth" : c.auth_method;
    setEditMethod(EDITABLE_METHODS.has(m) ? m : "browser_oauth");
    setEditSecret("");
    setEditPatChoice(emptyTokenChoice());
    setEditKeyChoice(emptyTokenChoice());
    setEditWarehouse(c.warehouse || "");
    setEditRole(c.role_name || "");
    setEditOptions(null);
    setEditOptionsErr(null);
    setEditManualWh(false);
    setEditManualRole(false);
    setEditWhAutoReplaced(false);
    setEditWhAutoSaved(false);
    setErr(null);
    setMsg(null);
    void loadEditOptions(c.id);
  }

  /** Cached WH/roles from Postgres; `refresh` re-queries Snowflake and updates the cache. */
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
      // API may already have healed; never heal from a cached (possibly stale) payload.
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
          await reload();
        } else if (next) {
          // Fallback: persist suggested WH once so Cost pill never sticks on a dead name.
          try {
            await api<{ message: string; connection: Conn }>(
              `/api/connections/${connectionId}`,
              {
                method: "PATCH",
                body: JSON.stringify({
                  warehouse: next,
                  revalidate: false,
                }),
              },
            );
            setEditWhAutoSaved(true);
            setMsg(`Warehouse inválido substituído e salvo: ${next}.`);
            await reload();
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

  /** Persist name / WH / role without re-auth (needed for Browser OAuth). */
  async function saveEditMeta(id: number) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await api<{ message: string; connection: Conn }>(`/api/connections/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim() || undefined,
          account_identifier: editAccount.trim(),
          username: editUser.trim(),
          warehouse: editWarehouse,
          role_name: editRole,
          clear_warehouse: !editWarehouse.trim(),
          clear_role: !editRole.trim(),
          revalidate: false,
        }),
      });
      setEditingId(null);
      setEditSecret("");
      setEditWhAutoReplaced(false);
      setEditWhAutoSaved(false);
      setMsg(res.message || "Warehouse/role salvos.");
      await reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao salvar warehouse/role.");
    } finally {
      setBusy(false);
    }
  }

  async function loadSigninOptions() {
    setSigninOptionsBusy(true);
    setSigninOptionsErr(null);
    if (method === "browser_oauth") {
      setSigninOptionsErr(
        "Após Conectar via browser, abra Editar na conexão salva para listar warehouses e roles.",
      );
      setSigninOptionsBusy(false);
      return;
    }
    if (!account.trim() || !sfUser.trim()) {
      setSigninOptionsErr("Preencha conta e usuário para listar warehouses e roles.");
      setSigninOptionsBusy(false);
      return;
    }
    const cred = credentialPayload(
      method,
      patChoice,
      keyChoice,
      secret || secretRef.current?.value || "",
      "signin",
    );
    if (!cred.ok) {
      setSigninOptionsErr(cred.error);
      setSigninOptionsBusy(false);
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
      setSigninOptions(res);
      signinOptionsKeyRef.current = signinIdentityKey();
      setSigninManualWh(false);
      setSigninManualRole(false);
      if (!warehouse.trim() && res.suggested_warehouse) {
        setWarehouse(res.suggested_warehouse);
      }
    } catch (e) {
      setSigninOptions(null);
      setSigninOptionsErr(
        e instanceof ApiError
          ? e.message
          : "Falha ao listar warehouses/roles. Digite manualmente.",
      );
      setSigninManualWh(true);
      setSigninManualRole(true);
    } finally {
      setSigninOptionsBusy(false);
    }
  }

  async function reconnectEditOAuth(id: number) {
    if (!editAccount.trim() || !editUser.trim()) {
      setErr("Preencha Account Identifier e Username.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await api<{ authorize_url: string }>("/api/connections/oauth/start", {
        method: "POST",
        body: JSON.stringify({
          connection_id: id,
          account_identifier: editAccount.trim(),
          username: editUser.trim(),
          name: editName.trim() || null,
          warehouse: editWarehouse.trim() || null,
          role_name: editRole.trim() || null,
          team_id: teamId === "" ? null : Number(teamId),
        }),
      });
      setMsg("Reconectando via browser…");
      window.location.href = res.authorize_url;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao iniciar OAuth.");
      setBusy(false);
    }
  }

  async function saveEdit(id: number, testOnly: boolean) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    if (editMethod === "browser_oauth") {
      await reconnectEditOAuth(id);
      return;
    }
    const cred = credentialPayload(
      editMethod,
      editPatChoice,
      editKeyChoice,
      editSecret || editSecretRef.current?.value || "",
      `edit-${id}`,
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
        const res = await api<{ message: string; connection: Conn }>(`/api/connections/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setEditingId(null);
        setEditSecret("");
        setMsg(res.message || "Conexão atualizada e autenticada.");
        await reload();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao editar/revalidar conexão.");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function remove(id: number) {
    await api(`/api/connections/${id}`, { method: "DELETE" });
    if (activeId === id) {
      setActiveConnectionId(null);
      setActiveId(null);
    }
    if (editingId === id) setEditingId(null);
    await reload();
  }

  async function startBrowserOAuth() {
    setErr(null);
    setMsg(null);
    if (!account.trim() || !sfUser.trim()) {
      setErr("Preencha Account Identifier e Username antes do login via browser.");
      return;
    }
    setBusy(true);
    try {
      const res = await api<{ authorize_url: string }>("/api/connections/oauth/start", {
        method: "POST",
        body: JSON.stringify({
          account_identifier: account.trim(),
          username: sfUser.trim(),
          name: name || null,
          warehouse: warehouse || null,
          role_name: roleName || null,
          team_id: teamId === "" ? null : Number(teamId),
        }),
      });
      setMsg("Redirecionando para o login Snowflake no browser…");
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
      await startBrowserOAuth();
      return;
    }
    const cred = credentialPayload(
      method,
      patChoice,
      keyChoice,
      secret || secretRef.current?.value || "",
      "signin",
    );
    if (!cred.ok) {
      setErr(cred.error);
      focusField(cred.focusId);
      return;
    }
    setBusy(true);
    setBusyAction(testOnly ? "test" : "save");
    const payload = {
      account_identifier: account,
      username: sfUser,
      auth_method: method,
      ...cred.payload,
      warehouse: warehouse || null,
      role_name: roleName || null,
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
        const options =
          signinOptions && signinOptionsKeyRef.current === signinIdentityKey()
            ? signinOptions
            : null;
        const res = await api<{ message: string; connection: Conn }>(
          "/api/connections",
          { method: "POST", body: JSON.stringify({ ...payload, options }) },
        );
        setMsg(res.message);
        setActiveConnectionId(res.connection.id);
        setActiveId(res.connection.id);
        setTab("hub");
        await reload();
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha na conexão.");
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  const methodMeta = ALL_METHODS.find((m) => m.key === method)!;
  const editMethodMeta = ALL_METHODS.find((m) => m.key === editMethod) ?? methodMeta;
  /** Backend error for an unregistered public key (key pair). */
  const keyNotRegistered = Boolean(err && err.includes("390144"));
  const keyFingerprint = keyNotRegistered ? (err?.match(/SHA256:[A-Za-z0-9+/=]+/)?.[0] ?? null) : null;

  return (
    <div>
      <h1>Conexões Snowflake</h1>
      <p className="muted">Salve contas de clientes e alterne o ambiente ativo.</p>

      {err && tab === "hub" && editingId == null ? (
        <div className="error-box" role="alert">
          {err}
        </div>
      ) : null}
      {msg && tab === "hub" ? <div className="success-box">{msg}</div> : null}

      <div className="tabs">
        <button
          type="button"
          className={tab === "hub" ? "active" : ""}
          onClick={() => setTab("hub")}
        >
          Contas salvas
        </button>
        <button
          type="button"
          className={tab === "signin" ? "active" : ""}
          onClick={() => openNewConnection()}
        >
          Sign in to Snowflake
        </button>
      </div>

      {tab === "hub" ? (
        <div className="stack">
          <div className="connections-hub-actions">
            <button type="button" className="btn primary" onClick={() => openNewConnection()}>
              + Nova conexão
            </button>
          </div>
          {!connections.length ? (
            <div className="info-box">
              Nenhuma conexão ainda. Clique em <strong>+ Nova conexão</strong> e use{" "}
              <strong>Browser OAuth (como Cortex)</strong> — login no browser, sem PAT.
            </div>
          ) : (
            <div className="connections-grid">
            {connections.map((c) => {
              const isActive = activeId === c.id;
              const isEditing = editingId === c.id;
              const displayWh = isEditing ? editWarehouse : c.warehouse;
              const displayRole = isEditing ? editRole : c.role_name;
              const matchWhSelectLabel =
                isEditing && !editManualWh && !!editOptions?.warehouses?.length;
              return (
                <div
                  key={c.id}
                  className={`row-card connection-card${isEditing ? " is-editing" : ""}`}
                >
                  <div className="connection-card-meta">
                    <strong>
                      {isEditing ? editName || c.name : c.name}
                      <span
                        className={
                          isActive ? "conn-status-active" : "conn-status-inactive"
                        }
                      >
                        {" · "}
                        {isActive ? "ativa" : "inativo"}
                      </span>
                    </strong>
                    <div className="muted">
                      {isEditing ? editAccount : c.account_identifier} ·{" "}
                      {isEditing ? editUser : c.username} ·{" "}
                      {METHOD_LABELS[isEditing ? editMethod : c.auth_method] ||
                        (isEditing ? editMethod : c.auth_method)}
                    </div>
                    <div className="muted">
                      WH:{" "}
                      {warehouseHeaderLabel(
                        displayWh,
                        editOptions?.warehouses,
                        matchWhSelectLabel,
                      )}{" "}
                      · Role: {displayRole?.trim() || "(padrão)"}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="btn" onClick={() => startEdit(c)}>
                      Editar
                    </button>
                    {isActive ? (
                      <button type="button" className="btn" onClick={inactivate}>
                        Inativar
                      </button>
                    ) : (
                      <button type="button" className="btn" onClick={() => void activate(c.id)}>
                        Ativar
                      </button>
                    )}
                    {user?.role === "admin" ? (
                      <button type="button" className="btn ghost" onClick={() => void remove(c.id)}>
                        Remover
                      </button>
                    ) : null}
                  </div>
                  {isEditing ? (
                    <div className="form-stack" style={{ marginTop: "0.75rem" }}>
                      <div className="info-box">
                        Revalide como um cadastro novo: altere os campos e autentique de novo. Ao
                        trocar o método, só os campos de credencial mudam.
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
                        <input
                          value={editUser}
                          onChange={(e) => setEditUser(e.target.value)}
                          required
                        />
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
                            ref={editSecretRef}
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
                          Browser OAuth: ao salvar, o login Snowflake abre no browser e substitui o
                          token desta conexão.
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
                      {editOptionsErr ? (
                        <div className="warn-box">{editOptionsErr}</div>
                      ) : null}
                      {editOptions?.hint ? (
                        <p className="muted" style={{ margin: 0 }}>
                          {editOptions.hint}
                        </p>
                      ) : (
                        <p className="muted" style={{ margin: 0 }}>
                          Prefira WH_CON_EXT. Se o monitor MONITORAMENTO_EMPRESA estiver sem
                          cota (090073), trocar o WH não resolve — aumente a cota ou aguarde o
                          reset mensal.
                        </p>
                      )}
                      {editWhAutoReplaced ? (
                        <div className={editWhAutoSaved ? "success-box" : "warn-box"}>
                          {editWhAutoSaved ? (
                            <>
                              O warehouse salvo não existia mais nesta conta. Foi substituído e
                              gravado automaticamente como{" "}
                              <strong>{editWarehouse || "(auto)"}</strong> — Cost Management já
                              usa este valor.
                            </>
                          ) : (
                            <>
                              O warehouse salvo na conexão não existe mais nesta conta. A lista
                              selecionou <strong>{editWarehouse || "(auto)"}</strong> — clique em{" "}
                              <strong>Salvar WH / Role</strong> para gravar (Cost Management usa o
                              valor salvo).
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
                      <div className="row-actions">
                        {editMethod === "browser_oauth" ? (
                          <>
                            <button
                              type="button"
                              className="btn primary"
                              disabled={busy}
                              onClick={() => void saveEditMeta(c.id)}
                            >
                              Salvar WH / Role
                            </button>
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void saveEdit(c.id, false)}
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
                              onClick={() => void saveEdit(c.id, true)}
                            >
                              {busyAction === "test" ? "Testando…" : "Testar conexão"}
                            </button>
                            <button
                              type="button"
                              className="btn primary"
                              disabled={busy}
                              aria-busy={busyAction === "save"}
                              onClick={() => void saveEdit(c.id, false)}
                            >
                              {busyAction === "save" ? "Salvando…" : "Salvar e revalidar"}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => {
                            setEditingId(null);
                            setEditSecret("");
                            setEditWhAutoReplaced(false);
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                      <p className="muted" style={{ margin: 0 }}>
                        Depois de autenticar, abra <Link to="/cost-management">Cost Management</Link>.
                      </p>
                    </div>
                  ) : null}
                </div>
              );
            })}
            </div>
          )}
        </div>
      ) : (
        <form
          className="form-stack"
          autoComplete="off"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <label htmlFor="signin-method">
            Método de autenticação
            <select
              id="signin-method"
              value={method}
              onChange={(e) => {
                setMethod(e.target.value);
                setErr(null);
                setMsg(null);
                setSigninOptionsErr(null);
              }}
              aria-describedby="signin-method-desc"
            >
              {METHODS_RECOMMENDED.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="info-box method-desc">
            <div id="signin-method-desc" aria-live="polite">
              <strong>{methodMeta.title}</strong>
              {methodMeta.desc}
            </div>
            <ServiceUserGuide
              id="signin-sf-guide"
              method={method}
              username={sfUser}
              role={roleName}
              fingerprint={keyFingerprint}
              open={signinGuideOpen}
              onOpenChange={setSigninGuideOpen}
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
              idPrefix="signin"
              kind={method}
              value={method === "pat" ? patChoice : keyChoice}
              onChange={method === "pat" ? setPatChoice : setKeyChoice}
              account={account}
              username={sfUser}
              onUseTokenIdentity={applySigninTokenIdentity}
            />
          ) : null}
          {method === "password" ? (
            <label htmlFor="signin-password">
              Senha *
              <input
                id="signin-password"
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
              {signinManualWh || !signinOptions?.warehouses?.length ? (
                <input
                  value={warehouse}
                  onChange={(e) => setWarehouse(e.target.value)}
                  placeholder="WH_CON_EXT ou vazio (auto)"
                  list="signin-wh-suggestions"
                />
              ) : (
                <select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
                  <option value="">(auto — escolher WH disponível)</option>
                  {signinOptions.warehouses
                    .filter((w) => w.suggested)
                    .map((w) => (
                      <option key={w.name} value={w.name}>
                        {warehouseOptionLabel(w)}
                      </option>
                    ))}
                </select>
              )}
            </label>
            <datalist id="signin-wh-suggestions">
              {(signinOptions?.warehouses || [])
                .filter((w) => w.suggested)
                .map((w) => (
                  <option key={w.name} value={w.name} />
                ))}
            </datalist>
            <label>
              Role
              {signinManualRole || !signinOptions?.roles?.length ? (
                <input
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  placeholder="ACCOUNTADMIN"
                  list="signin-role-suggestions"
                />
              ) : (
                <select value={roleName} onChange={(e) => setRoleName(e.target.value)}>
                  <option value="">(padrão da sessão)</option>
                  {signinOptions.roles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <datalist id="signin-role-suggestions">
              {(signinOptions?.roles || []).map((r) => (
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
                  disabled={signinOptionsBusy || busy}
                  aria-busy={signinOptionsBusy}
                  onClick={() => void loadSigninOptions()}
                >
                  {signinOptionsBusy ? "Listando…" : "Listar WH / Roles da conta"}
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setSigninManualWh((v) => !v);
                  setSigninManualRole((v) => !v);
                }}
              >
                {signinManualWh ? "Usar lista" : "Digitar manualmente"}
              </button>
            </div>
            {signinOptionsErr ? <div className="warn-box">{signinOptionsErr}</div> : null}
            {signinOptions?.hint ? (
              <p className="muted" style={{ margin: 0 }}>
                {signinOptions.hint}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Prefira WH_CON_EXT. WH_ANALISTA / SYSTEM$* podem falhar por cota do monitor
                MONITORAMENTO_EMPRESA (090073).
              </p>
            )}
          </details>

          <label>
            Time (ACL)
            <select
              value={teamId}
              onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : "")}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          {err ? (
            <div className="error-box" role="alert">
              {err}
              {keyNotRegistered && method === "keypair" ? (
                <div className="row-actions" style={{ marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="btn"
                    aria-controls="signin-sf-guide"
                    onClick={() => revealServiceUserGuide("signin-sf-guide", setSigninGuideOpen)}
                  >
                    Como registrar a chave no Snowflake
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {msg ? (
            <div className="success-box" role="status">
              {msg}
            </div>
          ) : null}

          <div className="row-actions">
            {method === "browser_oauth" ? (
              <button type="submit" className="btn primary" disabled={busy}>
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
                  type="submit"
                  className="btn primary"
                  disabled={busy}
                  aria-busy={busyAction === "save"}
                >
                  {busyAction === "save" ? "Salvando…" : "Sign In / Salvar"}
                </button>
              </>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
