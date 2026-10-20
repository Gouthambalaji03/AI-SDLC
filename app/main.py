from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.api.routes import router as orders_router

app = FastAPI(
    title="StateFlow - Order & Payment Lifecycle Engine",
    description="Resilient state machine engine with optimistic concurrency, idempotency, partial refunds, auto-expiration, and audit trails under the AI-SDLC framework.",
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files (dashboard)
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

app.include_router(orders_router)


@app.get("/", tags=["Dashboard"], include_in_schema=False)
def dashboard():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/health", tags=["Health"])
def health():
    return {
        "service": "StateFlow Order & Payment Lifecycle Engine",
        "status": "healthy",
        "framework": "AI-SDLC",
        "version": "2.0.0",
        "docs_url": "/docs",
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
