"""저장소 안의 주요 경로. 환경 변수로 바꿀 수 있다."""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def data_dir() -> Path:
    """부품·보드 JSON 데이터베이스 (data/)"""
    return Path(os.environ.get("AUTOINO_DATA_DIR", REPO_ROOT / "data"))


def projects_dir() -> Path:
    """서버에 저장한 프로젝트 파일 (projects/)"""
    return Path(os.environ.get("AUTOINO_PROJECTS_DIR", REPO_ROOT / "projects"))


def frontend_dist() -> Path:
    """빌드된 프런트엔드 (frontend/dist). 있으면 서버가 함께 제공한다."""
    return Path(os.environ.get("AUTOINO_FRONTEND_DIST", REPO_ROOT / "frontend" / "dist"))
