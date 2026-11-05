"""Streamlit starter for the App-ception.

Uses only the platform's pre-installed Streamlit (no requirements.txt), and
exercises what usually breaks behind a path prefix: the websocket session,
widget round-trips, session state and a second page.
"""
import os
import datetime as dt

import numpy as np
import pandas as pd
import streamlit as st

st.set_page_config(page_title="Streamlit starter", page_icon="📈", layout="wide")

user = st.context.headers.get("X-Forwarded-Preferred-Username") if hasattr(st, "context") else None
st.title("Streamlit starter")
st.caption(f"Hello {user or 'there'} · served from the catalog at {os.environ.get('APPCEPTION_BASE_PATH', os.environ.get('CATALOG_BASE_PATH', '/'))} · Streamlit {st.__version__}")

if "clicks" not in st.session_state:
    st.session_state.clicks = 0

left, right = st.columns([1, 2])
with left:
    days = st.slider("Days of synthetic traffic", 7, 90, 30)
    noise = st.select_slider("Noise", options=["low", "medium", "high"], value="medium")
    if st.button("Count a click"):
        st.session_state.clicks += 1
    st.metric("Clicks this session", st.session_state.clicks)
with right:
    rng = np.random.default_rng(42)
    scale = {"low": 3, "medium": 8, "high": 15}[noise]
    idx = pd.date_range(dt.date(2026, 1, 1), periods=days, freq="D")
    df = pd.DataFrame({"sessions": 100 + np.cumsum(rng.normal(1.5, scale, days))}, index=idx)
    st.line_chart(df)
st.success("If the slider redraws the chart, the websocket made it through the proxy.")
