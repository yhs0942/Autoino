"""Streamlit 페이지: Autoino 화면을 브라우저 창 가득 띄운다 (streamlit_app.py 가 /autoino 로 제공)."""

from __future__ import annotations

import os
from pathlib import Path

import streamlit as st

ROOT = Path(__file__).resolve().parent
DIST = Path(os.environ.get("AUTOINO_FRONTEND_DIST", ROOT / "frontend" / "dist"))

st.set_page_config(page_title="Autoino — 아두이노 회로 설계", page_icon="🔌", layout="wide", initial_sidebar_state="collapsed")

if not (DIST / "index.html").is_file():
    st.error("빌드된 화면이 없습니다. 아래 명령을 한 번 실행한 뒤 Streamlit 을 다시 시작하세요.")
    st.code("cd frontend\nnpm install\nnpm run build", language="bash")
    st.stop()

# Streamlit 의 머리글과 여백을 없애 Autoino 화면이 창 전체를 쓰게 한다
st.html(
    """
    <style>
      [data-testid="stHeader"], [data-testid="stToolbar"], footer { display: none !important; }
      [data-testid="stMainBlockContainer"], .block-container { padding: 0 !important; max-width: 100% !important; }
      [data-testid="stMain"] { overflow: hidden; }
      [data-testid="stMainBlockContainer"] [data-testid="stVerticalBlock"] { gap: 0 !important; }
      iframe { display: block; width: 100%; height: 100vh !important; border: 0; }
    </style>
    """
)
st.iframe("/autoino/", height=900)
