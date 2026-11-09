"""Autoino REST API (FastAPI).

실행: `python -m autoino serve` → http://127.0.0.1:8000 (API 문서: /docs)
frontend/dist 가 있으면 같은 주소에서 프런트엔드도 제공한다.
"""

from __future__ import annotations

from typing import Any

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, service
from .catalog import get_catalog, raw_catalog
from .paths import frontend_dist
from .project import ProjectFileError
from .simulate import SimulationError
from .storage import ProjectNotFound, ProjectStore

FEATURES = ["catalog", "projects", "analyze", "auto-assign", "codegen", "simulate"]
DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"]


class FrontendFiles(StaticFiles):
    """빌드된 화면 파일. index.html 은 매번 새 버전을 확인하게 하고, 이름에 해시가 붙은 assets 는 오래 캐시한다."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response = await super().get_response(path, scope)
        if path.replace("\\", "/").startswith("assets/"):  # Windows 는 경로 구분자가 \
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(store: ProjectStore | None = None, serve_frontend: bool = True) -> FastAPI:
    app = FastAPI(title="Autoino API", version=__version__, description="Arduino 회로 자동 설계 도구 Autoino 의 백엔드")
    app.add_middleware(CORSMiddleware, allow_origins=DEV_ORIGINS, allow_methods=["*"], allow_headers=["*"])
    projects = store or ProjectStore()

    @app.exception_handler(ProjectFileError)
    async def project_error(_: Request, exc: ProjectFileError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(SimulationError)
    async def simulation_error(_: Request, exc: SimulationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(ProjectNotFound)
    async def not_found(_: Request, exc: ProjectNotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": f"프로젝트를 찾을 수 없습니다: {exc.args[0]}"})

    # ---------------- 상태 · 카탈로그
    @app.get("/api/health")
    def health() -> dict:
        catalog = get_catalog()
        return {"status": "ok", "version": __version__, "features": FEATURES, "catalog": {"boards": len(catalog.boards), "modules": len(catalog.modules)}}

    @app.get("/api/catalog")
    def catalog() -> dict:
        return raw_catalog()

    @app.get("/api/boards")
    def boards() -> list[dict]:
        return raw_catalog()["boards"]

    @app.get("/api/boards/{board_id}")
    def board(board_id: str) -> dict:
        found = next((b for b in raw_catalog()["boards"] if b["id"] == board_id), None)
        if not found:
            raise HTTPException(404, f"보드를 찾을 수 없습니다: {board_id}")
        return found

    @app.get("/api/modules")
    def modules() -> list[dict]:
        return raw_catalog()["modules"]

    @app.get("/api/modules/{module_id}")
    def module(module_id: str) -> dict:
        found = next((m for m in raw_catalog()["modules"] if m["id"] == module_id), None)
        if not found:
            raise HTTPException(404, f"부품을 찾을 수 없습니다: {module_id}")
        return found

    # ---------------- 프로젝트 저장소
    @app.get("/api/projects")
    def list_projects() -> list[dict]:
        return [s.dump() for s in projects.list()]

    @app.post("/api/projects", status_code=201)
    def create_project(body: dict[str, Any] = Body(...)) -> dict:
        project_id, data = projects.create(body)
        return {"id": project_id, "project": data}

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str) -> dict:
        return {"id": project_id, "project": projects.get(project_id)}

    @app.put("/api/projects/{project_id}")
    def save_project(project_id: str, body: dict[str, Any] = Body(...)) -> dict:
        return {"id": project_id, "project": projects.save(project_id, body)}

    @app.delete("/api/projects/{project_id}", status_code=204, response_class=Response)
    def delete_project(project_id: str) -> Response:
        projects.delete(project_id)
        return Response(status_code=204)

    # ---------------- 회로 작업 (본문: {"project": 프로젝트 파일, "options": {...}})
    def project_of(body: dict) -> Any:
        if "project" not in body:
            raise HTTPException(422, "요청 본문에 project 가 필요합니다.")
        return body["project"]

    @app.post("/api/analyze")
    def analyze(body: dict[str, Any] = Body(...)) -> dict:
        return service.analyze(project_of(body))

    @app.post("/api/auto-assign")
    def auto_assign(body: dict[str, Any] = Body(...)) -> dict:
        route = body.get("route", "direct")
        if route not in ("direct", "breadboard"):
            raise HTTPException(422, "route 는 direct 또는 breadboard 여야 합니다.")
        return service.run_auto_assign(project_of(body), route)

    @app.post("/api/codegen")
    def codegen(body: dict[str, Any] = Body(...)) -> dict:
        return service.codegen(project_of(body))

    @app.post("/api/simulate")
    def simulate(body: dict[str, Any] = Body(...)) -> dict:
        options = body.get("options")
        if options is not None and not isinstance(options, dict):
            raise HTTPException(422, "options 는 객체여야 합니다.")
        return service.run_simulation(project_of(body), options)

    dist = frontend_dist()
    if serve_frontend and (dist / "index.html").is_file():
        app.mount("/", FrontendFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()
