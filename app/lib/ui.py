"""Shared UI helpers and Snowflake-like dark theme CSS."""
from __future__ import annotations

import streamlit as st


CUSTOM_CSS = """
<style>
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

html, body, [class*="css"] {
  font-family: 'IBM Plex Sans', sans-serif;
}

.block-container {
  padding-top: 1.25rem;
  padding-bottom: 2rem;
  max-width: 1200px;
}

[data-testid="stSidebar"] {
  background: #14171C;
  border-right: 1px solid #2A2F36;
}

[data-testid="stSidebar"] * {
  color: #E8EAED;
}

.sp-guide {
  border: 1px solid #3A4048;
  border-radius: 8px;
  padding: 1rem 1.1rem;
  background: #15181D;
  color: #C8CDD3;
  font-size: 0.92rem;
  line-height: 1.55;
  margin-bottom: 1.25rem;
}

.sp-guide ol {
  margin: 0.4rem 0 0 1.1rem;
  padding: 0;
}

.sp-guide a { color: #29B5E8; }

.sp-info {
  border-left: 3px solid #29B5E8;
  background: #15181D;
  border-radius: 0 8px 8px 0;
  padding: 0.75rem 1rem;
  color: #C8CDD3;
  font-size: 0.9rem;
  margin: 0.75rem 0 1rem 0;
}

.sp-kpi {
  font-size: 1.75rem;
  font-weight: 600;
  color: #F3F4F6;
  margin: 0.5rem 0 1rem 0;
}

.sp-banner {
  background: #1C2330;
  border: 1px solid #2E3A4D;
  color: #A8B3C4;
  border-radius: 8px;
  padding: 0.65rem 0.9rem;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}

.sp-muted {
  color: #8B939E;
  font-size: 0.85rem;
}

div[data-testid="stMetricValue"] {
  font-size: 1.6rem;
}

.stButton > button[kind="primary"] {
  background: #29B5E8;
  color: #0B0F14;
  border: none;
  font-weight: 600;
}

.stButton > button[kind="primary"]:hover {
  background: #4FC3EC;
  color: #0B0F14;
}
</style>
"""


def inject_theme() -> None:
    st.markdown(CUSTOM_CSS, unsafe_allow_html=True)


def page_setup(title: str, icon: str = "❄") -> None:
    st.set_page_config(
        page_title=f"{title} · snow_portal",
        page_icon=icon,
        layout="wide",
        initial_sidebar_state="expanded",
    )
    inject_theme()


def render_sidebar_user(user: dict) -> None:
    with st.sidebar:
        st.markdown("### snow_portal")
        st.caption(f"{user['username']} · {user['role']}")
        if user.get("team_name"):
            st.caption(f"Time: {user['team_name']}")
        st.divider()
