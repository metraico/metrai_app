import os
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

SIM_ENGINE_URL = os.getenv("SIM_ENGINE_URL", "http://localhost:8001")

app = FastAPI(title="Metrai App Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok"}

@app.post("/run")
async def run_simulation(req: dict):
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(f"{SIM_ENGINE_URL}/simulate", json=req)
            resp.raise_for_status()
            return resp.json()
    except httpx.ConnectError:
        raise HTTPException(status_code=503, detail="Simulation engine is not reachable")
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Simulation timed out")
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
