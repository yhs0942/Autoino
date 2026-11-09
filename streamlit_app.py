"""Autoino 를 Streamlit 으로 여는 실행 파일.

    streamlit run streamlit_app.py

Streamlit 서버 하나에 Autoino 백엔드(API)와 빌드된 프런트엔드를 /autoino 경로로 함께 얹는다.
화면은 streamlit_page.py 가 그린다. 포트는 Streamlit 포트 하나만 쓰므로 다른 PC 에서 접속해도 API 가 함께 동작한다.
"""

from __future__ import annotations

import sys
from pathlib import Path

from starlette.routing import Mount
from streamlit.starlette import App

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

from autoino.api import create_app  # noqa: E402 (backend 경로를 추가한 뒤에 가져온다)

app = App(ROOT / "streamlit_page.py", routes=[Mount("/autoino", app=create_app())])
