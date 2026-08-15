import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  createChannel,
  getChannels,
  testDraftChannel,
  testSavedChannel,
  updateChannel,
  type ChannelEvent,
  type ChannelProvider,
  type ChannelsResponse,
  type NotificationChannel,
} from "../api/channels";
import { api, ApiError } from "../api/client";

type Team = { id: number; name: string };
type Flash = { kind: "success" | "error"; text: string };

const PROVIDERS: {
  id: ChannelProvider;
  label: string;
  hint: string;
}[] = [
  {
    id: "teams",
    label: "Microsoft Teams",
    hint: "Cole a URL do Incoming Webhook do canal no Teams.",
  },
  { id: "slack", label: "Slack", hint: "Cole a URL do Incoming Webhook do app no Slack." },
  {
    id: "gchat",
    label: "Google Chat",
    hint: "Cole a URL do webhook do espaço no Google Chat.",
  },
];

const EVENTS: { id: ChannelEvent; label: string }[] = [
  { id: "critical", label: "Crítico (≥90%)" },
  { id: "alert", label: "Alerta (70–89,9%)" },
  { id: "monitor", label: "Monitor esgotado" },
  { id: "budget", label: "Orçamento excedido" },
  { id: "inactive", label: "Conexão inativa" },
];

const EMPTY_KPIS: ChannelsResponse["kpis"] = {
  active: 0,
  total: 0,
  providers: 0,
  failures_24h: 0,
  delivered_today: 0,
};

function providerLabel(provider: ChannelProvider) {
  return PROVIDERS.find((item) => item.id === provider)?.label || provider;
}

function statusLabel(status: NotificationChannel["status"]) {
  if (status === "active") return "Ativo";
  if (status === "paused") return "Pausado";
  return "Falha";
}

function formatDelivery(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ChannelsPage() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [kpis, setKpis] = useState(EMPTY_KPIS);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<"all" | ChannelProvider>("all");
  const [flash, setFlash] = useState<Flash | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ChannelProvider>("teams");
  const [webhook, setWebhook] = useState("");
  const [events, setEvents] = useState<ChannelEvent[]>(["critical", "alert"]);
  const [teamId, setTeamId] = useState<number | "">("");
  const [isActive, setIsActive] = useState(true);
  const [testing, setTesting] = useState(false);
  const firstInputRef = useRef<HTMLSelectElement>(null);

  function showFlash(kind: Flash["kind"], text: string) {
    setFlash({ kind, text });
  }

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 3000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  async function reload() {
    const [response, teamRows] = await Promise.all([
      getChannels(),
      api<Team[]>("/api/teams"),
    ]);
    setChannels(response.channels);
    setKpis(response.kpis);
    setTeams(teamRows);
    setTeamId((current) => {
      if (current !== "" && teamRows.some((team) => team.id === current)) return current;
      return teamRows[0]?.id ?? "";
    });
  }

  useEffect(() => {
    void reload()
      .catch((error) =>
        showFlash("error", error instanceof ApiError ? error.message : "Erro ao carregar canais."),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    document.body.classList.toggle("modal-open", modalOpen);
    if (modalOpen) window.setTimeout(() => firstInputRef.current?.focus(), 0);
    return () => document.body.classList.remove("modal-open");
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setModalOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modalOpen]);

  const filteredChannels = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("pt-BR");
    return channels.filter((channel) => {
      if (providerFilter !== "all" && channel.provider !== providerFilter) return false;
      if (!normalized) return true;
      return [
        channel.name,
        providerLabel(channel.provider),
        channel.destination || "",
        channel.team_name || "",
        statusLabel(channel.status),
      ]
        .join(" ")
        .toLocaleLowerCase("pt-BR")
        .includes(normalized);
    });
  }, [channels, providerFilter, query]);

  const eventCounts = useMemo(
    () =>
      Object.fromEntries(
        EVENTS.map((event) => [
          event.id,
          channels.filter((channel) => channel.events.includes(event.id)).length,
        ]),
      ) as Record<ChannelEvent, number>,
    [channels],
  );

  function openCreate(selectedProvider: ChannelProvider = "teams") {
    setEditingId(null);
    setName("");
    setProvider(selectedProvider);
    setWebhook("");
    setEvents(["critical", "alert"]);
    setTeamId(teams[0]?.id ?? "");
    setIsActive(true);
    setModalOpen(true);
  }

  function openEdit(channel: NotificationChannel) {
    setEditingId(channel.id);
    setName(channel.name);
    setProvider(channel.provider);
    setWebhook("");
    setEvents(channel.events);
    setTeamId(channel.team_id ?? "");
    setIsActive(channel.is_active);
    setModalOpen(true);
  }

  function toggleEvent(event: ChannelEvent) {
    setEvents((current) =>
      current.includes(event) ? current.filter((item) => item !== event) : [...current, event],
    );
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!events.length) {
      showFlash("error", "Selecione ao menos um evento.");
      return;
    }
    try {
      const payload = {
        name: name.trim(),
        provider,
        webhook: webhook.trim() || undefined,
        events,
        team_id: teamId === "" ? null : Number(teamId),
        clear_team: teamId === "",
        is_active: isActive,
      };
      if (editingId == null) {
        if (!webhook.trim()) {
          showFlash("error", "Informe a URL do webhook.");
          return;
        }
        await createChannel({ ...payload, webhook: webhook.trim() });
        showFlash("success", `Canal ${name.trim()} criado.`);
      } else {
        await updateChannel(editingId, payload);
        showFlash("success", `Canal ${name.trim()} atualizado.`);
      }
      setModalOpen(false);
      await reload();
    } catch (error) {
      showFlash(
        "error",
        error instanceof ApiError ? error.message : "Falha ao salvar o canal.",
      );
    }
  }

  async function testCurrent() {
    setTesting(true);
    try {
      let response: { message: string };
      if (editingId != null && !webhook.trim()) {
        response = await testSavedChannel(editingId);
      } else {
        if (!webhook.trim()) {
          showFlash("error", "Informe a URL do webhook antes de testar.");
          return;
        }
        response = await testDraftChannel({
          name: name.trim() || "Novo canal",
          provider,
          webhook: webhook.trim(),
        });
      }
      showFlash("success", response.message);
      await reload();
    } catch (error) {
      showFlash(
        "error",
        error instanceof ApiError
          ? `Falha ao enviar teste: ${error.message}`
          : "Falha ao enviar mensagem de teste.",
      );
      await reload().catch(() => undefined);
    } finally {
      setTesting(false);
    }
  }

  async function testProvider(selectedProvider: ChannelProvider) {
    const channel =
      channels.find((item) => item.provider === selectedProvider && item.is_active) ||
      channels.find((item) => item.provider === selectedProvider);
    if (!channel) {
      openCreate(selectedProvider);
      return;
    }
    setTesting(true);
    try {
      const response = await testSavedChannel(channel.id);
      showFlash("success", response.message);
    } catch (error) {
      showFlash(
        "error",
        error instanceof ApiError ? error.message : "Falha ao enviar mensagem de teste.",
      );
    } finally {
      setTesting(false);
      await reload().catch(() => undefined);
    }
  }

  return (
    <div className="channels-page">
      {flash ? (
        <div className={`admin-flash is-${flash.kind}`} role="status" aria-live="polite">
          {flash.text}
        </div>
      ) : null}

      <div className="admin-overview">
        <div className="admin-page-header">
          <h1>Canais e comunicação</h1>
        </div>
        <div className="admin-kpis" aria-label="Resumo de canais e entregas">
          <article className="admin-kpi is-ok">
            <div className="admin-kpi-label">Canais ativos</div>
            <div className="admin-kpi-value">
              <strong>{kpis.active}</strong>
              <small>de {kpis.total}</small>
            </div>
          </article>
          <article className="admin-kpi is-attention">
            <div className="admin-kpi-label">Provedores conectados</div>
            <div className="admin-kpi-value">
              <strong>{kpis.providers}</strong>
              <small>de 3</small>
            </div>
          </article>
          <article className="admin-kpi is-alert">
            <div className="admin-kpi-label">Falhas em 24h</div>
            <div className="admin-kpi-value">
              <strong>{kpis.failures_24h}</strong>
              <small>entregas</small>
            </div>
          </article>
          <article className="admin-kpi is-neutral">
            <div className="admin-kpi-label">Eventos roteados hoje</div>
            <div className="admin-kpi-value">
              <strong>{kpis.delivered_today}</strong>
              <small>mensagens</small>
            </div>
          </article>
        </div>
        <hr className="admin-kpi-divider" aria-hidden="true" />
      </div>

      <div className="admin-content">
        {loading ? <p className="muted">Carregando…</p> : null}
        <section className="admin-panel" aria-labelledby="channels-title">
          <div className="admin-panel-head">
            <h2 id="channels-title">Canais</h2>
            <div className="admin-panel-actions">
              <label className="admin-search">
                <span className="sr-only">Buscar canal</span>
                <input
                  type="search"
                  placeholder="Buscar canal…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className="sr-only" htmlFor="provider-filter">
                Filtrar provedor
              </label>
              <select
                id="provider-filter"
                className="channels-filter"
                value={providerFilter}
                onChange={(event) =>
                  setProviderFilter(event.target.value as "all" | ChannelProvider)
                }
              >
                <option value="all">Todos</option>
                {PROVIDERS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn primary" onClick={() => openCreate()}>
                + Novo canal
              </button>
            </div>
          </div>
          <div className="admin-table channels-table" role="table" aria-label="Lista de canais">
            <div className="admin-table-head" role="row">
              <span role="columnheader">Nome</span>
              <span role="columnheader">Provedor</span>
              <span role="columnheader">Destino</span>
              <span role="columnheader">Eventos</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Última entrega</span>
            </div>
            {filteredChannels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className="admin-table-row is-editable"
                role="row"
                onClick={() => openEdit(channel)}
              >
                <span className="channels-truncate">{channel.name}</span>
                <span>
                  <span className={`admin-badge is-${channel.provider}`}>
                    {providerLabel(channel.provider)}
                  </span>
                </span>
                <span className="channels-muted channels-truncate">
                  {channel.destination || "—"}
                </span>
                <span className="channels-muted">
                  {channel.events.length === EVENTS.length
                    ? "Todos"
                    : `${channel.events.length} eventos`}
                </span>
                <span>
                  <span className={`admin-badge is-channel-${channel.status}`}>
                    {statusLabel(channel.status)}
                  </span>
                </span>
                <span className="channels-muted">
                  {formatDelivery(channel.last_delivery_at)}
                </span>
              </button>
            ))}
            {!filteredChannels.length ? (
              <div className="admin-table-empty">
                {channels.length
                  ? "Nenhum canal encontrado."
                  : "Nenhum canal configurado. Conecte Teams, Slack ou Google Chat para receber alertas."}
              </div>
            ) : null}
          </div>
        </section>

        <div className="admin-split">
          <section className="admin-panel" aria-labelledby="providers-title">
            <div className="admin-panel-head">
              <h2 id="providers-title">Provedores</h2>
            </div>
            <div className="channels-provider-list">
              {PROVIDERS.map((item) => {
                const count = channels.filter((channel) => channel.provider === item.id).length;
                return (
                  <article key={item.id} className="channels-provider-card">
                    <div>
                      <div className="channels-provider-title">
                        {item.label}
                        <span
                          className={`admin-badge ${count ? "is-active" : "is-inactive"}`}
                        >
                          {count ? "Conectado" : "Não configurado"}
                        </span>
                      </div>
                      <div className="channels-muted">
                        {count} {count === 1 ? "canal" : "canais"}
                      </div>
                    </div>
                    <div className="channels-provider-actions">
                      <button type="button" className="btn" onClick={() => openCreate(item.id)}>
                        {count ? "Novo" : "Conectar"}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={!count || testing}
                        onClick={() => void testProvider(item.id)}
                      >
                        Testar
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="admin-panel" aria-labelledby="events-title">
            <div className="admin-panel-head">
              <h2 id="events-title">Eventos</h2>
            </div>
            <div className="admin-table channels-events-table" role="table">
              <div className="admin-table-head" role="row">
                <span role="columnheader">Evento</span>
                <span role="columnheader">Canais</span>
              </div>
              {EVENTS.map((event) => (
                <div key={event.id} className="admin-table-row" role="row">
                  <span>{event.label}</span>
                  <span className="mono">{eventCounts[event.id]}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {modalOpen ? (
        <div
          className="admin-modal-backdrop"
          role="presentation"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="admin-modal channels-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="channel-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="admin-modal-head">
              <div>
                <h2 id="channel-modal-title">
                  {editingId == null ? "Novo canal" : "Editar canal"}
                </h2>
                <p className="admin-modal-lead">
                  Conecte um webhook e escolha quais alertas devem ser enviados.
                </p>
              </div>
              <button
                type="button"
                className="btn admin-modal-close"
                onClick={() => setModalOpen(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            <form className="admin-form" onSubmit={save}>
              <label>
                Provedor
                <select
                  ref={firstInputRef}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value as ChannelProvider)}
                >
                  {PROVIDERS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Nome do canal
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ex.: FinOps crítico"
                  required
                />
              </label>
              <label>
                Webhook URL
                <input
                  className="mono"
                  type="url"
                  value={webhook}
                  onChange={(event) => setWebhook(event.target.value)}
                  placeholder={editingId == null ? "https://…" : "•••••••• (deixe vazio para manter)"}
                  required={editingId == null}
                  autoComplete="off"
                />
              </label>
              <p className="channels-form-note">
                {PROVIDERS.find((item) => item.id === provider)?.hint}
              </p>
              <fieldset className="channels-event-fieldset">
                <legend>Eventos</legend>
                <div className="channels-event-checks">
                  {EVENTS.map((event) => (
                    <label key={event.id} className="channels-check-row">
                      <input
                        type="checkbox"
                        checked={events.includes(event.id)}
                        onChange={() => toggleEvent(event.id)}
                      />
                      {event.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label>
                Time responsável
                <select
                  value={teamId}
                  onChange={(event) =>
                    setTeamId(event.target.value ? Number(event.target.value) : "")
                  }
                >
                  <option value="">—</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="channels-inline-check">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(event) => setIsActive(event.target.checked)}
                />
                Canal ativo
              </label>
              <div className="admin-modal-actions">
                <button type="button" className="btn" onClick={() => setModalOpen(false)}>
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={testing}
                  onClick={() => void testCurrent()}
                >
                  {testing ? "Testando…" : "Enviar teste"}
                </button>
                <button type="submit" className="btn primary">
                  {editingId == null ? "Salvar canal" : "Salvar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
