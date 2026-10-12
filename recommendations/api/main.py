"""
SOUQNAA — Recommendation Engine
FastAPI Microservice for Low-Latency Hybrid Machine Learning Inference
"""

import os
import sys
import json
import pickle
import subprocess
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

# Add training directory to import path so pickled SouqnaHybridRecommender class is found
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
TRAINING_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '../training'))
MODELS_DIR = os.path.abspath(os.path.join(CURRENT_DIR, '../models'))
if TRAINING_DIR not in sys.path:
    sys.path.insert(0, TRAINING_DIR)

import train_lightfm  # Ensures SouqnaHybridRecommender is registered for pickle unpickling

from schemas import (
    UserRecommendationRequest,
    UserRecommendationResponse,
    TrainingTriggerRequest,
    TrainingTriggerResponse,
    ProductScore,
)

model_instance = None
model_metadata = {}

def load_active_model():
    global model_instance, model_metadata
    meta_path = os.path.join(MODELS_DIR, 'metadata.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r', encoding='utf-8') as f:
            model_metadata = json.load(f)

    version = model_metadata.get('modelVersion', 'model_v1')
    model_path = os.path.join(MODELS_DIR, f"{version}.pkl")

    if os.path.exists(model_path):
        try:
            with open(model_path, 'rb') as f:
                model_instance = pickle.load(f)
            print(f"[FastAPI] Loaded active recommendation model: {version}")
        except Exception as e:
            print(f"[FastAPI] Warning loading model ({e}). Rebuilding...")
            model_instance = None
    else:
        print("[FastAPI] No model artifact found on boot. Model will train on trigger.")

@asynccontextmanager
async def lifespan(app: FastAPI):
    load_active_model()
    yield

app = FastAPI(
    title="SOUQNAA Recommendation Engine API",
    description="High-performance open-source LightFM & Hybrid WARP recommendation inference service",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "souqnaa-ml-recommendations",
        "modelLoaded": model_instance is not None,
        "modelVersion": model_metadata.get("modelVersion", "none"),
        "algorithm": model_metadata.get("algorithm", "none"),
    }

@app.post("/recommendations/user", response_model=UserRecommendationResponse)
async def recommend_for_user(req: UserRecommendationRequest):
    global model_instance
    if model_instance is None:
        load_active_model()

    if model_instance is None:
        # Fallback to empty list so Node.js rule-based engine automatically kicks in
        return UserRecommendationResponse(
            userId=req.userId,
            modelVersion="rule_fallback",
            recommendations=[],
        )

    try:
        raw_recs = model_instance.predict(req.userId)
        clamped = [
            ProductScore(productId=pid, score=round(float(score), 4))
            for pid, score in raw_recs[: req.limit or 20]
        ]
        return UserRecommendationResponse(
            userId=req.userId,
            modelVersion=model_metadata.get("modelVersion", "model_v1"),
            recommendations=clamped,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Inference error: {str(e)}")

@app.post("/training/trigger", response_model=TrainingTriggerResponse)
async def trigger_training(req: TrainingTriggerRequest):
    script_path = os.path.join(TRAINING_DIR, req.pipelineName or "export_model.py")
    if not os.path.exists(script_path):
        raise HTTPException(status_code=400, detail=f"Script not found: {req.pipelineName}")

    try:
        subprocess.Popen([sys.executable, script_path], cwd=TRAINING_DIR)
        return TrainingTriggerResponse(
            success=True,
            message=f"Launched offline training script: {req.pipelineName}",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start training: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8008, reload=False)
