import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { ApiError } from "../api/client";
import {
  listSavedTokens,
  listTokenFiles,
  MAX_TOKEN_FILE_BYTES,
  tokenFieldIds,
  type SavedToken,
  type TokenChoice,
  type TokenFilesResponse,
  type TokenKind,
  type TokenSource,
} from "../api/tokens";

type Props = {
  idPrefix: string;
  kind: TokenKind;
  value: TokenChoice;
  onChange: (next: TokenChoice) => void;
  /** Current form identity, to warn when a saved token belongs to someone else. */
  account: string;
  username: string;
  /** Fill account/user from the token; `force` overwrites typed values. Returns true if anything changed. */
  onUseTokenIdentity: (token: SavedToken, force: boolean) => boolean;
  /** Edit form: preselect this connection's own token and tag it in the list. */
  currentConnectionId?: number;
};

const COPY: Record<TokenKind, {
  legend: string;
  saved: string;
  savedLabel: string;
  savedPlaceholder: string;
  empty: string;
  fileTypes: string;
  accept: string;
}> = {
  pat: {
    legend: "Programmatic Access Token *",
    saved: "Token salvo",
    savedLabel: "Token salvo no portal",
    savedPlaceholder: "Selecione um token…",
    empty:
      "Nenhum PAT salvo ainda. Na primeira conexão, selecione o arquivo ou cole o token: ele é " +
      "criptografado, gravado no banco e aparece aqui nas próximas vezes.",
    fileTypes: ".txt / .token",
    accept: ".txt,.token,text/plain",
  },
  keypair: {
    legend: "Chave privada RSA *",
    saved: "Chave salva",
    savedLabel: "Chave salva no portal",
    savedPlaceholder: "Selecione uma chave…",
    empty:
      "Nenhuma chave salva ainda. Na primeira conexão, selecione o arquivo .p8: ele é " +
      "criptografado, gravado no banco e aparece aqui nas próximas vezes.",
    fileTypes: ".p8 / .pem / .key",
    accept: ".p8,.pem,.key",
  },
};

const SOURCE_LABELS: Record<string, string> = {
  folder: "pasta de tokens",
  upload: "arquivo enviado",
  typed: "colado no formulário",
  saved_token: "reaproveitado de outra conexão",
  oauth: "login OAuth",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
}

function expiryLabel(t: SavedToken): string {
  if (t.status === "expired") return `expirado em ${formatDate(t.expires_at)}`;
  if (t.expires_at) return `válido até ${formatDate(t.expires_at)}`;
  return "sem validade definida";
}

function shortFolder(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function sameIdentity(a: string | null | undefined, b: string): boolean {
  return (a || "").trim().toLowerCase() === b.trim().toLowerCase();
}

function savedOptionLabel(t: SavedToken, currentConnectionId?: number): string {
  const owner = `${t.username || "?"} @ ${t.account_identifier || "?"}`;
  const name = t.connection_name || `conexão ${t.connection_id}`;
  const mine = t.connections.some((c) => c.id === currentConnectionId) ? " (desta conexão)" : "";
  const fp = t.fingerprint ? ` · #${t.fingerprint.slice(0, 8)}` : "";
  return `${name}${mine} — ${owner} · ${expiryLabel(t)}${fp}`;
}

/** Validate an uploaded file client-side; returns an error message or null. */
function uploadProblem(kind: TokenKind, content: string): string | null {
  const head = content.trimStart().slice(0, 200).toUpperCase();
  const isPrivate = head.startsWith("-----BEGIN") && head.includes("PRIVATE KEY");
  if (kind === "keypair") {
    if (head.includes("PUBLIC KEY") && !isPrivate) {
      return "Esse é o arquivo da chave pública (.pub). Selecione a chave privada (.p8).";
    }
    if (!isPrivate) return "Esse arquivo não parece uma chave privada PEM (-----BEGIN PRIVATE KEY-----).";
    return null;
  }
  if (isPrivate) return "Esse arquivo é uma chave privada. Troque o método para Key pair (RSA).";
  if (!content.trim()) return "O arquivo está vazio.";
  return null;
}

export function TokenSourceField({
  idPrefix,
  kind,
  value,
  onChange,
  account,
  username,
  onUseTokenIdentity,
  currentConnectionId,
}: Props) {
  const ids = tokenFieldIds(idPrefix);
  const copy = COPY[kind];
  const [saved, setSaved] = useState<SavedToken[] | null>(null);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  const [files, setFiles] = useState<TokenFilesResponse | null>(null);
  const [filesErr, setFilesErr] = useState<string | null>(null);
  const [filesBusy, setFilesBusy] = useState(true);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

  const loadSaved = useCallback(async () => {
    setSaved(null);
    setSavedErr(null);
    try {
      setSaved(await listSavedTokens(kind));
    } catch (e) {
      setSaved([]);
      setSavedErr(e instanceof ApiError ? e.message : "Não foi possível carregar os tokens salvos.");
    }
  }, [kind]);

  const loadFiles = useCallback(async () => {
    setFilesBusy(true);
    setFilesErr(null);
    try {
      setFiles(await listTokenFiles(kind));
    } catch (e) {
      setFiles(null);
      setFilesErr(e instanceof ApiError ? e.message : "Não foi possível listar a pasta de tokens.");
    } finally {
      setFilesBusy(false);
    }
  }, [kind]);

  useEffect(() => {
    void loadSaved();
    void loadFiles();
    setUploadErr(null);
    setPrefilled(false);
  }, [loadSaved, loadFiles]);

  // First load decides the default: reuse a saved token when one exists, else pick a file.
  useEffect(() => {
    if (value.source !== null || saved === null) return;
    const usable = saved.filter((t) => t.status === "active");
    const own = usable.find((t) => t.connections.some((c) => c.id === currentConnectionId));
    if (own) onChange({ ...value, source: "saved", tokenId: own.id });
    else onChange({ ...value, source: usable.length ? "saved" : "file" });
  }, [saved, value, onChange, currentConnectionId]);

  const selected = saved?.find((t) => t.id === value.tokenId) ?? null;
  const selectedFile = files?.files.find((f) => f.name === value.folderFile) ?? null;
  const encrypted =
    kind === "keypair" &&
    ((value.upload && /ENCRYPTED/i.test(value.upload.content.slice(0, 200))) ||
      (!value.upload && Boolean(selectedFile?.encrypted)));
  const mismatch =
    selected &&
    account.trim() &&
    username.trim() &&
    (!sameIdentity(selected.account_identifier, account) || !sameIdentity(selected.username, username));

  function setSource(source: TokenSource) {
    setUploadErr(null);
    onChange({ ...value, source });
  }

  function pickSaved(e: ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value ? Number(e.target.value) : null;
    onChange({ ...value, tokenId: id });
    const token = saved?.find((t) => t.id === id);
    setPrefilled(token ? onUseTokenIdentity(token, false) : false);
  }

  async function pickUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadErr(null);
    if (file.size > MAX_TOKEN_FILE_BYTES) {
      setUploadErr("Arquivo grande demais para um token (máx. 64 KB).");
      return;
    }
    const content = await file.text();
    const problem = uploadProblem(kind, content);
    if (problem) {
      setUploadErr(problem);
      return;
    }
    onChange({ ...value, folderFile: "", upload: { name: file.name, size: file.size, content } });
  }

  const sources: { key: TokenSource; label: string }[] = [
    { key: "saved", label: copy.saved },
    { key: "file", label: "Arquivo" },
    ...(kind === "pat" ? [{ key: "paste" as const, label: "Colar token" }] : []),
  ];

  return (
    <fieldset className="token-source" id={ids.source}>
      <legend>{copy.legend}</legend>
      <div className="segmented" role="radiogroup" aria-label="Origem do token">
        {sources.map((s) => (
          <label key={s.key} className={value.source === s.key ? "is-checked" : undefined}>
            <input
              type="radio"
              className="sr-only"
              name={`${idPrefix}-token-source`}
              value={s.key}
              checked={value.source === s.key}
              onChange={() => setSource(s.key)}
            />
            {s.label}
          </label>
        ))}
      </div>

      {value.source === "saved" ? (
        saved === null ? (
          <p className="muted token-source-status" role="status">
            Carregando tokens salvos…
          </p>
        ) : savedErr ? (
          <div className="error-box token-source-box" role="alert">
            {savedErr}{" "}
            <button type="button" className="btn ghost btn-inline" onClick={() => void loadSaved()}>
              Tentar de novo
            </button>
          </div>
        ) : !saved.length ? (
          <div className="info-box token-source-box">
            {copy.empty}
            <div className="row-actions" style={{ marginTop: "0.5rem" }}>
              <button type="button" className="btn" onClick={() => setSource("file")}>
                Selecionar arquivo
              </button>
            </div>
          </div>
        ) : (
          <>
            <label htmlFor={ids.saved}>
              {copy.savedLabel}
              <select id={ids.saved} value={value.tokenId ?? ""} onChange={pickSaved}>
                <option value="">{copy.savedPlaceholder}</option>
                {saved.map((t) => (
                  <option key={t.id} value={t.id} disabled={t.status !== "active"}>
                    {savedOptionLabel(t, currentConnectionId)}
                  </option>
                ))}
              </select>
            </label>
            {selected ? (
              <dl className="token-meta" aria-label="Detalhes do token selecionado">
                <dt>Conta</dt>
                <dd>{selected.account_identifier || "—"}</dd>
                <dt>Usuário</dt>
                <dd>{selected.username || "—"}</dd>
                <dt>Validade</dt>
                <dd>{expiryLabel(selected)}</dd>
                <dt>Fingerprint</dt>
                <dd className="mono">#{(selected.fingerprint || "").slice(0, 8) || "—"}</dd>
                <dt>Origem</dt>
                <dd>
                  {SOURCE_LABELS[selected.source || ""] || "—"}
                  {selected.source_file ? ` (${selected.source_file})` : ""}
                </dd>
                <dt>Usado em</dt>
                <dd>{selected.connections.map((c) => c.name || `#${c.id}`).join(", ")}</dd>
              </dl>
            ) : null}
            {prefilled && !mismatch ? (
              <p className="muted token-source-status" role="status">
                Conta e usuário preenchidos a partir {kind === "keypair" ? "da chave salva" : "do token salvo"}.
              </p>
            ) : null}
            {mismatch ? (
              <div className="warn-box token-source-box">
                Este {kind === "keypair" ? "par de chaves" : "token"} foi salvo para{" "}
                <strong>
                  {selected.username} @ {selected.account_identifier}
                </strong>
                . O Snowflake só aceita para o mesmo usuário.
                <div className="row-actions" style={{ marginTop: "0.5rem" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onUseTokenIdentity(selected, true)}
                  >
                    Usar conta e usuário do token
                  </button>
                </div>
              </div>
            ) : null}
            {kind === "keypair" ? (
              <p className="muted token-source-status">
                A passphrase (se houver) foi salva junto com a chave.
              </p>
            ) : null}
          </>
        )
      ) : null}

      {value.source === "file" ? (
        <>
          {filesErr ? (
            <div className="error-box token-source-box" role="alert">
              {filesErr}{" "}
              <button type="button" className="btn ghost btn-inline" onClick={() => void loadFiles()}>
                Tentar de novo
              </button>
            </div>
          ) : files && !files.available ? (
            <div className="warn-box token-source-box">
              A pasta de tokens não está configurada no servidor (TOKENS_EXPORT_DIR). Envie o
              arquivo do computador.
            </div>
          ) : (
            <div className="token-field">
              <label htmlFor={ids.folder}>
                <span>
                  Arquivo da pasta de tokens{" "}
                  {files?.folder ? (
                    <span className="muted mono" title={files.folder}>
                      ({shortFolder(files.folder)})
                    </span>
                  ) : null}
                </span>
              </label>
              <div className="token-file-row">
                <select
                  id={ids.folder}
                  value={value.upload ? "" : value.folderFile}
                  disabled={filesBusy || !files}
                  aria-busy={filesBusy}
                  onChange={(e) =>
                    onChange({ ...value, folderFile: e.target.value, upload: null })
                  }
                >
                  <option value="">
                    {filesBusy
                      ? "Listando arquivos…"
                      : files?.files.length
                        ? "Selecione um arquivo…"
                        : `Nenhum arquivo ${copy.fileTypes} na pasta`}
                  </option>
                  {(files?.files || []).map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name} · {formatSize(f.size)} · {formatDate(f.modified_at)}
                      {f.encrypted ? " · criptografada" : ""}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={filesBusy}
                  onClick={() => void loadFiles()}
                  aria-label="Atualizar lista de arquivos"
                  title="Atualizar lista de arquivos"
                >
                  ↻
                </button>
              </div>
            </div>
          )}
          <div className="token-upload">
            <span className="muted">ou</span>
            <label className="btn file-pick" htmlFor={ids.upload}>
              Enviar do computador
              <input
                id={ids.upload}
                type="file"
                className="sr-only"
                accept={copy.accept}
                onChange={(e) => void pickUpload(e)}
              />
            </label>
            {value.upload ? (
              <span className="token-upload-name">
                {value.upload.name} ({formatSize(value.upload.size)})
                <button
                  type="button"
                  className="btn ghost btn-inline"
                  onClick={() => onChange({ ...value, upload: null })}
                >
                  Remover
                </button>
              </span>
            ) : null}
          </div>
          {uploadErr ? (
            <div className="error-box token-source-box" role="alert">
              {uploadErr}
            </div>
          ) : null}
          <p className="muted token-source-status">
            O conteúdo é lido pelo servidor, criptografado e gravado no banco; o segredo nunca é
            exibido de volta.
          </p>
        </>
      ) : null}

      {value.source === "paste" ? (
        <label htmlFor={ids.paste}>
          Token
          <input
            id={ids.paste}
            type="password"
            value={value.pasted}
            onChange={(e) => onChange({ ...value, pasted: e.target.value })}
            placeholder="Cole o PAT gerado no Snowflake"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : null}

      {kind === "keypair" && value.source === "file" ? (
        <label htmlFor={ids.passphrase}>
          {encrypted ? "Passphrase da chave *" : "Passphrase da chave (opcional)"}
          <input
            id={ids.passphrase}
            type="password"
            value={value.passphrase}
            onChange={(e) => onChange({ ...value, passphrase: e.target.value })}
            placeholder={encrypted ? "Esta chave está criptografada" : "Só se a chave for criptografada"}
            autoComplete="off"
            aria-required={encrypted || undefined}
          />
        </label>
      ) : null}
    </fieldset>
  );
}
