from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import router
from .core import build_session_factory, get_settings
from .migrations import run_migrations


def create_app() -> FastAPI:
    settings = get_settings()
    db_factory = build_session_factory(settings)
    run_migrations()

    app = FastAPI(title="xox API", version="0.1.0")
    app.state.settings = settings
    app.state.db_factory = db_factory
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.cors_origin],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    return app


app = create_app()
