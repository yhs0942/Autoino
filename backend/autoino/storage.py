"""서버 쪽 프로젝트 저장소 (projects/<id>.autoino.json).

파일 이름은 서버가 만든 ID 만 쓰므로 사용자가 보낸 값이 경로가 되지 않는다.
저장 전에 parse_project 로 검증하고, 정규화한 버전 2 형식으로 쓴다.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .paths import projects_dir
from .project import ProjectFileError, parse_project, to_project_file

ID_PATTERN = re.compile(r"^[a-z0-9]{12}$")
SUFFIX = ".autoino.json"


class ProjectNotFound(KeyError):
    """없는 프로젝트 ID"""


@dataclass
class ProjectSummary:
    id: str
    name: str
    saved_at: str
    boards: list[str]
    module_count: int
    connection_count: int

    def dump(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "savedAt": self.saved_at,
            "boards": self.boards,
            "moduleCount": self.module_count,
            "connectionCount": self.connection_count,
        }


class ProjectStore:
    def __init__(self, directory: Path | None = None) -> None:
        self.directory = directory or projects_dir()

    def _path(self, project_id: str) -> Path:
        if not ID_PATTERN.fullmatch(project_id):
            raise ProjectNotFound(project_id)
        return self.directory / f"{project_id}{SUFFIX}"

    def _write(self, path: Path, data: dict) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=".tmp-", suffix=SUFFIX)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    @staticmethod
    def _summary(project_id: str, data: dict) -> ProjectSummary:
        return ProjectSummary(
            id=project_id,
            name=data.get("name", ""),
            saved_at=data.get("savedAt", ""),
            boards=[b.get("boardId", "") for b in data.get("boards", [])],
            module_count=len(data.get("modules", [])),
            connection_count=len(data.get("connections", [])),
        )

    def list(self) -> list[ProjectSummary]:
        if not self.directory.is_dir():
            return []
        items = []
        for path in self.directory.glob(f"*{SUFFIX}"):
            project_id = path.name[: -len(SUFFIX)]
            if not ID_PATTERN.fullmatch(project_id):
                continue
            try:
                with open(path, encoding="utf-8") as f:
                    items.append(self._summary(project_id, json.load(f)))
            except (OSError, ValueError):
                continue  # 손상된 파일은 목록에서 뺀다
        return sorted(items, key=lambda s: s.saved_at, reverse=True)

    def get(self, project_id: str) -> dict:
        path = self._path(project_id)
        if not path.is_file():
            raise ProjectNotFound(project_id)
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def create(self, raw: Any) -> tuple[str, dict]:
        data = to_project_file(parse_project(raw))
        while True:
            project_id = secrets.token_hex(6)
            if not self._path(project_id).exists():
                break
        self._write(self._path(project_id), data)
        return project_id, data

    def save(self, project_id: str, raw: Any) -> dict:
        path = self._path(project_id)
        if not path.is_file():
            raise ProjectNotFound(project_id)
        data = to_project_file(parse_project(raw))
        self._write(path, data)
        return data

    def delete(self, project_id: str) -> None:
        path = self._path(project_id)
        if not path.is_file():
            raise ProjectNotFound(project_id)
        path.unlink()


__all__ = ["ProjectFileError", "ProjectNotFound", "ProjectStore", "ProjectSummary"]
