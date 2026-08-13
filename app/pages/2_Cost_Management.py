"""Cost Management → Consumption (créditos ACCOUNT_USAGE)."""
from __future__ import annotations

import plotly.express as px
import streamlit as st

from app.lib import auth, db
from app.lib.metering import chart_frame, fetch_consumption, summarize_by_resource
from app.lib.ui import inject_theme, page_setup, render_sidebar_user

page_setup("Cost Management")
inject_theme()

user = auth.require_login()
render_sidebar_user(user)
with st.sidebar:
    if st.button("Sair", key="logout_cost"):
        auth.logout()
        st.rerun()

st.markdown("## Cost Management")

tabs = st.tabs(
    [
        "Organization Overview",
        "Account Overview",
        "Consumption",
        "Anomalies",
        "Budgets",
        "Resource Monitors",
    ]
)

with tabs[0]:
    st.info("Organization Overview — previsto para a onda 2.")
with tabs[1]:
    st.info("Account Overview — previsto para a onda 2.")
with tabs[3]:
    st.info("Anomalies — previsto para a onda 2.")
with tabs[4]:
    st.info("Budgets — previsto para a onda 2.")
with tabs[5]:
    st.info("Resource Monitors — previsto para a onda 2.")

with tabs[2]:
    st.markdown(
        """
        <div class="sp-banner">
          Dados de <code>SNOWFLAKE.ACCOUNT_USAGE</code> podem ter atraso de algumas horas
          em relação ao console Snowflake.
        </div>
        """,
        unsafe_allow_html=True,
    )

    connections = db.list_connections_for_user(user)
    if not connections:
        st.warning("Cadastre uma conexão em **Conexões** antes de ver créditos.")
        st.stop()

    conn_labels = {f"{c['name']} ({c['account_identifier']})": c["id"] for c in connections}
    active_id = auth.get_active_connection_id()
    default_idx = 0
    ids = list(conn_labels.values())
    if active_id in ids:
        default_idx = ids.index(active_id)

    f1, f2, f3, f4, f5 = st.columns([1.2, 1.6, 1.2, 1.2, 1.2])
    days_label = f1.selectbox("Time Range", ["Last 7 days", "Last 28 days", "Last 90 days"], index=1)
    days_map = {"Last 7 days": 7, "Last 28 days": 28, "Last 90 days": 90}
    days = days_map[days_label]

    selected_label = f2.selectbox("Account", list(conn_labels.keys()), index=default_idx)
    selected_id = conn_labels[selected_label]
    if selected_id != active_id:
        auth.set_active_connection_id(selected_id)

    usage_type = f3.selectbox("Usage Type", ["All", "Compute", "Cloud Services"], index=1)
    grain = f4.selectbox("By", ["Day", "Month"], index=0)
    grain_sql = "day" if grain == "Day" else "month"

    refresh = f5.button("Atualizar", type="primary")

    try:
        creds = db.get_connection_credentials(selected_id)
    except ValueError as exc:
        st.error(str(exc))
        st.stop()

    service_filter = st.selectbox(
        "Service Type",
        ["All"]
        + [
            "WAREHOUSE_METERING",
            "AI_SERVICES",
            "AI_INFERENCE",
            "SNOWPARK_CONTAINER_SERVICES",
            "AUTO_CLUSTERING",
            "PIPE",
            "SERVERLESS_TASK",
            "QUERY_ACCELERATION",
            "REPLICATION",
        ],
        index=0,
    )
    service_type = None if service_filter == "All" else service_filter

    try:
        with st.spinner("Consultando METERING_HISTORY…"):
            raw = fetch_consumption(
                account=creds["account"],
                user=creds["user"],
                auth_method=creds["auth_method"],
                password=creds.get("password"),
                authenticator_url=creds.get("authenticator_url"),
                days=days,
                grain=grain_sql,
                service_type=service_type,
                usage_type=usage_type,
                warehouse=creds.get("warehouse"),
                role=creds.get("role"),
            )
    except Exception as exc:  # noqa: BLE001
        st.error(
            "Falha ao consultar créditos. Confirme autenticação, role com acesso a "
            "`SNOWFLAKE.ACCOUNT_USAGE` e warehouse."
        )
        st.code(str(exc))
        st.stop()

    _ = refresh

    if raw.empty:
        st.info("Nenhum consumo encontrado para os filtros selecionados.")
        st.stop()

    summary = summarize_by_resource(raw)
    total = float(summary["credits_used"].sum())
    st.markdown(f'<div class="sp-kpi">{total:,.1f} credits used</div>', unsafe_allow_html=True)

    chart_df = chart_frame(raw)
    if not chart_df.empty:
        # Limit legend to top N resources for readability
        top_resources = (
            summary.head(12)["resource_name"].tolist() if not summary.empty else []
        )
        plot_df = chart_df[chart_df["resource_name"].isin(top_resources)] if top_resources else chart_df
        fig = px.bar(
            plot_df,
            x="period_start",
            y="credits_display",
            color="resource_name",
            labels={
                "period_start": "",
                "credits_display": "Credits",
                "resource_name": "Resource",
            },
            title=None,
        )
        fig.update_layout(
            barmode="stack",
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
            font_color="#E8EAED",
            legend=dict(orientation="h", yanchor="bottom", y=1.02, x=0),
            margin=dict(l=10, r=10, t=40, b=10),
            height=360,
        )
        fig.update_xaxes(showgrid=False)
        fig.update_yaxes(gridcolor="#2A2F36")
        st.plotly_chart(fig, use_container_width=True)

    st.markdown("#### Uso por recurso")
    max_credits = float(summary["credits_used"].max()) if not summary.empty else 1.0
    table = summary.copy()
    table["NAME"] = table["resource_name"]
    table["TYPE"] = table["type_label"]
    table["TAGS"] = table["tags"]
    table["CREDITS USED"] = table["credits_used"].map(lambda v: f"{v:,.1f}")
    table["share"] = table["credits_used"] / max_credits if max_credits else 0

    header = st.columns([3, 2, 1.5, 2.5])
    header[0].markdown("**NAME**")
    header[1].markdown("**TYPE**")
    header[2].markdown("**TAGS**")
    header[3].markdown("**CREDITS USED**")

    for _, row in table.iterrows():
        cols = st.columns([3, 2, 1.5, 2.5])
        cols[0].write(row["NAME"])
        cols[1].write(row["TYPE"])
        cols[2].write(row["TAGS"])
        bar_cols = cols[3].columns([2, 1])
        bar_cols[0].progress(min(float(row["share"]), 1.0))
        bar_cols[1].write(row["CREDITS USED"])
