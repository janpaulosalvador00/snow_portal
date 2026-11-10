import { useEffect, useRef, useState } from "react";

type Props = {
  /** Auth method selected in the form (browser_oauth, pat, password, keypair). */
  method: string;
  /** Value of the Usuário field; fills `<usuario>` in the snippets. */
  username: string;
  /** Value of the Role field; fills ROLE_RESTRICTION for PAT. */
  role?: string;
  /** SHA256 fingerprint parsed from a 390144 error, if any. */
  fingerprint?: string | null;
  /** Id of the <details>; used by `revealServiceUserGuide`. */
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const NETWORK_POLICY = "SNOW_PORTAL_NP";
const PAT_NAME = "SNOW_PORTAL";

/** Unquoted when it is a plain identifier, else a double-quoted (case-sensitive) one. */
function sqlIdent(value: string, placeholder: string): string {
  const v = value.trim();
  if (!v) return placeholder;
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(v) ? v : `"${v.replace(/"/g, '""')}"`;
}

function sqlString(value: string, placeholder: string): string {
  const v = value.trim();
  return `'${(v || placeholder).replace(/'/g, "''")}'`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // navigator.clipboard is undefined outside secure contexts (http on a non-localhost host).
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function Snippet({ label, code }: { label: string; code: string }) {
  const [state, setState] = useState<"ok" | "fail" | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    const ok = await copyText(code);
    setState(ok ? "ok" : "fail");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState(null), 2000);
  }

  return (
    <div className="sf-guide-snippet">
      <div className="sf-guide-snippet-head">
        <span>{label}</span>
        <button
          type="button"
          className="btn ghost btn-inline"
          onClick={() => void copy()}
          aria-label={`Copiar: ${label}`}
        >
          {state === "ok" ? "Copiado ✓" : state === "fail" ? "Falhou" : "Copiar"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
      <span className="sr-only" role="status">
        {state === "ok" ? "Copiado para a área de transferência." : state === "fail" ? "Não foi possível copiar." : ""}
      </span>
    </div>
  );
}

/** Open the guide and move focus to its summary (e.g. from a 390144 error). */
export function revealServiceUserGuide(id: string, setOpen: (open: boolean) => void) {
  setOpen(true);
  requestAnimationFrame(() => {
    const summary = document.querySelector<HTMLElement>(`#${CSS.escape(id)} > summary`);
    summary?.focus({ preventScroll: true });
    summary?.scrollIntoView({ block: "start", behavior: "smooth" });
  });
}

export function ServiceUserGuide({ method, username, role = "", fingerprint, id, open, onOpenChange }: Props) {
  if (method === "browser_oauth" || method === "password") {
    return (
      <p className="sf-guide-note">
        Não funciona com usuários de serviço (<code>TYPE = SERVICE</code>): eles não têm senha nem
        login interativo. Para esses usuários, use PAT ou Key pair (RSA).
      </p>
    );
  }
  if (method !== "pat" && method !== "keypair") return null;

  const u = sqlIdent(username, "<usuario>");

  return (
    <details
      id={id}
      className="sf-guide"
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
    >
      <summary>
        Como configurar no Snowflake <span className="muted">(usuário de serviço)</span>
      </summary>
      {method === "pat" ? (
        <div className="sf-guide-body">
          <p>
            Usuários <code>TYPE = SERVICE</code> só usam PAT com uma network policy que libere o IP
            de saída do portal. Rode como <code>SECURITYADMIN</code> (ou dono do usuário).
          </p>
          <ol>
            <li>
              Liberar o IP do portal
              <Snippet
                label="Network policy"
                code={
                  `CREATE NETWORK POLICY ${NETWORK_POLICY}\n` +
                  `  ALLOWED_IP_LIST = ('<IP_DE_SAIDA_DO_PORTAL>');\n` +
                  `ALTER USER ${u} SET NETWORK_POLICY = ${NETWORK_POLICY};`
                }
              />
            </li>
            <li>
              Criar o token (<code>ROLE_RESTRICTION</code> é obrigatório para usuários de serviço)
              <Snippet
                label="Criar PAT"
                code={
                  `ALTER USER ${u} ADD PROGRAMMATIC ACCESS TOKEN ${PAT_NAME}\n` +
                  `  DAYS_TO_EXPIRY = 90\n` +
                  `  ROLE_RESTRICTION = ${sqlString(role.toUpperCase(), "<ROLE>")};`
                }
              />
              Copie o <code>token_secret</code> do resultado: ele aparece uma única vez. Cole ou
              envie aqui no portal.
            </li>
            <li>
              Validade: padrão de 15 dias, máximo de 365. Anote o vencimento e gire antes dele;
              depois, troque o token nesta conexão (Editar → Salvar e revalidar).
              <Snippet
                label="Girar PAT"
                code={`ALTER USER ${u} ROTATE PROGRAMMATIC ACCESS TOKEN ${PAT_NAME};`}
              />
            </li>
          </ol>
        </div>
      ) : (
        <div className="sf-guide-body">
          <p>
            O portal assina com a chave privada (.p8); a chave pública precisa estar registrada no
            usuário Snowflake.
          </p>
          <ol>
            <li>
              Gerar o par (terminal)
              <Snippet
                label="Gerar chaves"
                code={
                  "openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt\n" +
                  "openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub"
                }
              />
              Sem <code>-nocrypt</code>, o openssl pede uma passphrase: informe-a no campo
              Passphrase.
            </li>
            <li>
              Registrar a chave pública, sem as linhas <code>-----BEGIN/END PUBLIC KEY-----</code>
              <Snippet
                label="Chave pública em uma linha"
                code={`grep -v "PUBLIC KEY" rsa_key.pub | tr -d '\\n'`}
              />
              <Snippet
                label="Registrar chave"
                code={`ALTER USER ${u} SET RSA_PUBLIC_KEY = 'MIIBIjANBgkq...';`}
              />
            </li>
            <li>
              Conferir: <code>RSA_PUBLIC_KEY_FP</code> deve ser igual ao fingerprint SHA256 que o
              portal mostra no erro 390144
              {fingerprint ? (
                <>
                  {" "}
                  (desta chave: <code className="sf-guide-fp">{fingerprint}</code>)
                </>
              ) : null}
              .
              <Snippet label="Conferir" code={`DESC USER ${u};`} />
            </li>
            <li>
              Rotação sem downtime: registre a nova chave no slot 2, troque o .p8 nesta conexão e
              remova a antiga.
              <Snippet
                label="Girar chave"
                code={
                  `ALTER USER ${u} SET RSA_PUBLIC_KEY_2 = 'MIIB...';\n` +
                  `-- depois de revalidar a conexão com a nova chave:\n` +
                  `ALTER USER ${u} UNSET RSA_PUBLIC_KEY;`
                }
              />
            </li>
          </ol>
        </div>
      )}
    </details>
  );
}
