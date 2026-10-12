"""
SOUQNAA — Recommendation Training Pipeline
Step 7: export_model.py
Packages model artifact, records version metadata, and registers model in PostgreSQL.
"""

import os
import sys
import json
import psycopg2
from dotenv import load_dotenv

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
if OUTPUT_DIR not in sys.path:
    sys.path.insert(0, OUTPUT_DIR)

if hasattr(sys.stdout, 'reconfigure'):
    try:
        getattr(sys.stdout, 'reconfigure')(encoding='utf-8')
    except Exception:
        pass
if hasattr(sys.stderr, 'reconfigure'):
    try:
        getattr(sys.stderr, 'reconfigure')(encoding='utf-8')
    except Exception:
        pass

env_path = os.path.join(OUTPUT_DIR, '../../.env')
if os.path.exists(env_path):
    load_dotenv(env_path)
else:
    load_dotenv()

MODELS_DIR = os.path.join(OUTPUT_DIR, '../models')
raw_db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/souqna_db")
DATABASE_URL = raw_db_url.split('?')[0] if raw_db_url else ""


def export_and_register_model():
    meta_path = os.path.join(MODELS_DIR, 'metadata.json')
    if not os.path.exists(meta_path):
        try:
            from .evaluate import run_evaluation
        except (ImportError, ValueError):
            from evaluate import run_evaluation
        run_evaluation()

    with open(meta_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    model_version = meta.get('modelVersion', 'model_v1')
    algorithm = meta.get('algorithm', 'LIGHTFM_WARP_HYBRID')
    artifact_path = os.path.join(MODELS_DIR, f"{model_version}.pkl")
    parameters = json.dumps(meta.get('parameters', {}))
    metrics = json.dumps(meta.get('metrics', {}))

    print(f"[export_model] Registering {model_version} into database...")

    conn = None
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor()

        # Demote previous active models
        cursor.execute("""
            UPDATE "souqna"."RecommendationModel"
            SET "isProduction" = false
            WHERE "isProduction" = true
        """)

        # Upsert model
        cursor.execute("""
            INSERT INTO "souqna"."RecommendationModel"
            ("id", "modelVersion", "algorithm", "status", "artifactPath",
             "parameters", "metrics", "isProduction", "trainedAt")
            VALUES (gen_random_uuid(), %s, %s, 'ACTIVE', %s, %s, %s, true, NOW())
            ON CONFLICT ("modelVersion") DO UPDATE
            SET "status" = 'ACTIVE',
                "artifactPath" = EXCLUDED."artifactPath",
                "parameters" = EXCLUDED."parameters",
                "metrics" = EXCLUDED."metrics",
                "isProduction" = true,
                "trainedAt" = NOW()
        """, (model_version, algorithm, artifact_path, parameters, metrics))

        conn.commit()
        print(f"[export_model] Successfully registered {model_version} as production model in DB.")
    except Exception as e:
        print(f"[export_model] Database registration note: {e}")
    finally:
        if conn:
            conn.close()


if __name__ == '__main__':
    export_and_register_model()
