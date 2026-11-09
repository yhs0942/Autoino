"""Streamlit 실행 파일 (streamlit 이 설치되어 있을 때만)"""

from pathlib import Path

import pytest

pytest.importorskip("streamlit")

from streamlit.testing.v1 import AppTest  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PAGE = str(ROOT / "streamlit_page.py")


def test_page_shows_app_when_built(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<!doctype html>", encoding="utf-8")
    monkeypatch.setenv("AUTOINO_FRONTEND_DIST", str(tmp_path))
    page = AppTest.from_file(PAGE).run()
    assert not page.exception
    assert not page.error


def test_page_explains_build_when_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOINO_FRONTEND_DIST", str(tmp_path / "없음"))
    page = AppTest.from_file(PAGE).run()
    assert not page.exception
    assert "빌드된 화면이 없습니다" in page.error[0].value
    assert "npm run build" in page.code[0].value


def _iframe_src(page) -> str:
    for node in page._tree.children[0].children.values():
        proto = getattr(node, "proto", None)
        if proto is not None and getattr(proto, "srcdoc", ""):
            return proto.srcdoc
    raise AssertionError("iframe 없음")


def test_page_opens_app_with_build_version(tmp_path, monkeypatch):
    """브라우저가 예전 index.html 을 계속 쓰지 않도록, 빌드가 바뀌면 화면 주소도 바뀐다"""
    monkeypatch.setenv("AUTOINO_FRONTEND_DIST", str(tmp_path))
    (tmp_path / "index.html").write_text("<!doctype html>1", encoding="utf-8")
    first = _iframe_src(AppTest.from_file(PAGE).run())
    (tmp_path / "index.html").write_text("<!doctype html>2", encoding="utf-8")
    second = _iframe_src(AppTest.from_file(PAGE).run())
    assert "autoino/?v=" in first
    assert first != second
