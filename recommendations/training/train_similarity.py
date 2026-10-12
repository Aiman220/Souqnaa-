"""
SOUQNAA — Recommendation Training Pipeline
Step 5: train_similarity.py
Computes offline item-to-item cosine similarity matrix using scikit-learn
without external AI APIs.
"""

import os
import sys
import json
import pickle
import numpy as np
from scipy import sparse
from sklearn.metrics.pairwise import cosine_similarity

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

DATA_DIR = os.path.join(OUTPUT_DIR, '../data')
MODELS_DIR = os.path.join(OUTPUT_DIR, '../models')


def train_similarity():
    features_path = os.path.join(DATA_DIR, 'item_features.npz')
    meta_path = os.path.join(DATA_DIR, 'feature_meta.json')

    if not os.path.exists(features_path):
        try:
            from .build_features import build_features
        except (ImportError, ValueError):
            from build_features import build_features
        build_features()

    item_features = sparse.load_npz(features_path)
    with open(meta_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)

    product_ids = meta['product_ids']
    num_products = len(product_ids)
    print(
        f"[train_similarity] Computing cosine similarity matrix for "
        f"{num_products} products..."
    )

    # Calculate pairwise cosine similarity matrix
    sim_matrix = cosine_similarity(item_features)

    # For each product, extract top 20 most similar (excluding itself)
    top_similar = {}
    for i, pid in enumerate(product_ids):
        # Zero out diagonal (self similarity)
        sim_scores = sim_matrix[i].copy()
        sim_scores[i] = -1.0

        top_indices = np.argsort(sim_scores)[::-1][:20]
        top_similar[pid] = [
            {
                'productId': product_ids[idx],
                'similarityScore': round(float(sim_scores[idx]), 4)
            }
            for idx in top_indices if sim_scores[idx] > 0.05
        ]

    # Save artifact
    output_path = os.path.join(MODELS_DIR, 'top_similar.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(top_similar, f, indent=2)

    with open(os.path.join(MODELS_DIR, 'similarity_matrix.pkl'), 'wb') as f:
        pickle.dump({'product_ids': product_ids, 'matrix': sim_matrix}, f)

    print(
        f"[train_similarity] Successfully generated and saved similarity "
        f"graph to {output_path}"
    )
    return top_similar


if __name__ == '__main__':
    train_similarity()
