import { api } from "./client";

/** Auth methods whose credential can come from a saved token or a file. */
export type TokenKind = "pat" | "keypair";

export type SavedToken = {
  id: number;
  token_type: "pat" | "password" | "private_key";
  auth_method: string | null;
  status: "active" | "expired";
  connection_id: number;
  connection_name: string | null;
  account_identifier: string | null;
  username: string | null;
  role_name: string | null;
  fingerprint: string | null;
  issued_at: string | null;
  expires_at: string | null;
  updated_at: string | null;
  source: string | null;
  source_file: string | null;
  connections: { id: number; name: string | null }[];
};

export type TokenFile = {
  name: string;
  size: number;
  modified_at: string;
  kind: "private_key" | "token";
  encrypted: boolean;
};

export type TokenFilesResponse = {
  available: boolean;
  folder: string;
  files: TokenFile[];
};

export function listSavedTokens(kind: TokenKind) {
  return api<SavedToken[]>(`/api/connection-tokens?method=${kind}`);
}

export function listTokenFiles(kind: TokenKind) {
  return api<TokenFilesResponse>(`/api/connection-tokens/files?method=${kind}`);
}

export type TokenSource = "saved" | "file" | "paste";

export type TokenChoice = {
  /** null until the field decides a default (saved when any exist, else file). */
  source: TokenSource | null;
  tokenId: number | null;
  folderFile: string;
  upload: { name: string; size: number; content: string } | null;
  pasted: string;
  passphrase: string;
};

export function emptyTokenChoice(): TokenChoice {
  return { source: null, tokenId: null, folderFile: "", upload: null, pasted: "", passphrase: "" };
}

/** Request fields understood by the API (token_id / token_file / secret + origin). */
export type SecretPayload = {
  secret?: string;
  secret_source?: "typed" | "upload";
  secret_file_name?: string;
  token_id?: number;
  token_file?: string;
  passphrase?: string;
};

export type SecretResult =
  | { ok: true; payload: SecretPayload }
  | { ok: false; error: string; focusId: string };

export const MAX_TOKEN_FILE_BYTES = 64 * 1024;

export function tokenFieldIds(idPrefix: string) {
  return {
    source: `${idPrefix}-token-source`,
    saved: `${idPrefix}-token-saved`,
    folder: `${idPrefix}-token-folder`,
    upload: `${idPrefix}-token-upload`,
    paste: `${idPrefix}-token-paste`,
    passphrase: `${idPrefix}-token-passphrase`,
  };
}

export function buildTokenPayload(
  kind: TokenKind,
  choice: TokenChoice,
  idPrefix: string,
): SecretResult {
  const ids = tokenFieldIds(idPrefix);
  const noun = kind === "keypair" ? "chave" : "token";
  const passphrase =
    kind === "keypair" && choice.passphrase ? { passphrase: choice.passphrase } : {};

  if (choice.source === "saved") {
    if (choice.tokenId == null) {
      const error =
        kind === "keypair" ? "Escolha uma chave salva na lista." : "Escolha um token salvo na lista.";
      return { ok: false, error, focusId: ids.saved };
    }
    return { ok: true, payload: { token_id: choice.tokenId } };
  }
  if (choice.source === "file") {
    if (choice.upload) {
      return {
        ok: true,
        payload: {
          secret: choice.upload.content,
          secret_source: "upload",
          secret_file_name: choice.upload.name,
          ...passphrase,
        },
      };
    }
    if (choice.folderFile) {
      return { ok: true, payload: { token_file: choice.folderFile, ...passphrase } };
    }
    return {
      ok: false,
      error: "Selecione um arquivo da pasta de tokens ou envie um do computador.",
      focusId: ids.folder,
    };
  }
  if (choice.source === "paste") {
    const pasted = choice.pasted.trim();
    if (!pasted) return { ok: false, error: "Cole o token.", focusId: ids.paste };
    return { ok: true, payload: { secret: pasted, secret_source: "typed", ...passphrase } };
  }
  return { ok: false, error: `Escolha de onde vem o ${noun}.`, focusId: ids.source };
}
