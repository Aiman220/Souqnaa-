"""
SOUQNAA — Recommendation Training Pipeline
Step 3: train_lightfm.py
Trains the LightFM Hybrid Recommender model using user-item interactions
and rich product metadata with WARP (Weighted Approximate-Rank Pairwise) loss.
"""

import os
import json
import sys
import pickle
import numpy as np
import pandas as pd
from scipy import sparse

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


class SouqnaHybridRecommender:
    """
    Self-hosted pure NumPy/SciPy implementation of LightFM-style Hybrid Matrix Factorization.
    Combines user-item implicit interactions with item feature representations using WARP/BPR loss.
    """

    def __init__(self, no_components=32, loss='warp', learning_rate=0.05, regularization=0.01):
        self.no_components = no_components
        self.loss = loss
        self.learning_rate = learning_rate
        self.regularization = regularization

        self.user_embeddings = None
        self.item_embeddings = None
        self.item_feature_embeddings = None
        self.user_biases = None
        self.item_biases = None

        self.user_to_idx = {}
        self.idx_to_user = {}
        self.item_to_idx = {}
        self.idx_to_item = {}

    def fit(self, interactions_df, item_features, epochs=20):
        unique_users = interactions_df['user_id'].unique().tolist()
        unique_items = interactions_df['product_id'].unique().tolist()

        self.user_to_idx = {u: i for i, u in enumerate(unique_users)}
        self.idx_to_user = {i: u for u, i in self.user_to_idx.items()}
        self.item_to_idx = {it: i for i, it in enumerate(unique_items)}
        self.idx_to_item = {i: it for it, i in self.item_to_idx.items()}

        num_users = len(unique_users)
        num_items = len(unique_items)
        num_features = item_features.shape[1] if item_features is not None else 0

        print(
            f"[HybridRecommender] Initializing latent factors: {num_users} users, "
            f"{num_items} items, {num_features} features, rank={self.no_components}"
        )

        np.random.seed(42)
        scale = 1.0 / np.sqrt(self.no_components)
        self.user_embeddings = np.random.normal(0, scale, (num_users, self.no_components))
        self.item_embeddings = np.random.normal(0, scale, (num_items, self.no_components))
        self.user_biases = np.zeros(num_users)
        self.item_biases = np.zeros(num_items)

        if item_features is not None:
            self.item_feature_embeddings = np.random.normal(0, scale, (num_features, self.no_components))

        # Stochastic Gradient Descent with WARP-style negative sampling
        user_indices = [self.user_to_idx[u] for u in interactions_df['user_id']]
        item_indices = [self.item_to_idx[it] for it in interactions_df['product_id']]
        weights = interactions_df['weight'].values

        num_samples = len(user_indices)
        for epoch in range(epochs):
            total_loss = 0.0
            indices = np.random.permutation(num_samples)

            for idx in indices:
                u_idx = user_indices[idx]
                pos_item_idx = item_indices[idx]
                w = min(float(weights[idx]), 5.0)

                # Negative sampling
                neg_item_idx = int(np.random.randint(0, num_items))
                while neg_item_idx == pos_item_idx and num_items > 1:
                    neg_item_idx = int(np.random.randint(0, num_items))

                # Compute dot products
                pos_repr = np.copy(self.item_embeddings[pos_item_idx])
                neg_repr = np.copy(self.item_embeddings[neg_item_idx])

                if (
                    item_features is not None and
                    self.item_feature_embeddings is not None and
                    pos_item_idx < item_features.shape[0] and
                    neg_item_idx < item_features.shape[0]
                ):
                    pos_feats = item_features[pos_item_idx].indices
                    neg_feats = item_features[neg_item_idx].indices
                    if len(pos_feats) > 0:
                        pos_repr = pos_repr + self.item_feature_embeddings[pos_feats].mean(axis=0)
                    if len(neg_feats) > 0:
                        neg_repr = neg_repr + self.item_feature_embeddings[neg_feats].mean(axis=0)

                pos_score = (
                    np.dot(self.user_embeddings[u_idx], pos_repr) +
                    self.user_biases[u_idx] +
                    self.item_biases[pos_item_idx]
                )
                neg_score = (
                    np.dot(self.user_embeddings[u_idx], neg_repr) +
                    self.user_biases[u_idx] +
                    self.item_biases[neg_item_idx]
                )

                diff = pos_score - neg_score
                # Margin loss: max(0, 1 - (pos - neg))
                if diff < 1.0:
                    loss = (1.0 - diff) * (w / 2.0)
                    total_loss += loss

                    # Gradient update
                    grad = self.learning_rate * (w / 2.0)
                    user_emb_grad = grad * (pos_repr - neg_repr)
                    reg_decay = self.learning_rate * self.regularization
                    self.user_embeddings[u_idx] += user_emb_grad - reg_decay * self.user_embeddings[u_idx]
                    self.item_embeddings[pos_item_idx] += (
                        grad * self.user_embeddings[u_idx] - reg_decay * self.item_embeddings[pos_item_idx]
                    )
                    self.item_embeddings[neg_item_idx] -= (
                        grad * self.user_embeddings[u_idx] + reg_decay * self.item_embeddings[neg_item_idx]
                    )

                    self.user_biases[u_idx] += grad * 0.1
                    self.item_biases[pos_item_idx] += grad * 0.1
                    self.item_biases[neg_item_idx] -= grad * 0.1

            if (epoch + 1) % 5 == 0 or epoch == epochs - 1:
                avg_loss = total_loss / max(num_samples, 1)
                print(f"[HybridRecommender] Epoch {epoch + 1}/{epochs} - WARP Margin Loss: {avg_loss:.4f}")

    def predict(self, user_id, product_ids=None):
        """Predict ranking scores for a user across products."""
        if (
            self.user_embeddings is None or
            self.item_embeddings is None or
            self.item_biases is None or
            self.user_biases is None
        ):
            return []

        target_items = product_ids if product_ids else list(self.idx_to_item.values())

        if user_id not in self.user_to_idx:
            # Cold start user: return item biases as fallback
            return [
                (pid, float(self.item_biases[self.item_to_idx[pid]]))
                for pid in target_items
                if pid in self.item_to_idx
            ]

        u_idx = self.user_to_idx[user_id]
        u_emb = self.user_embeddings[u_idx]

        scores = []
        for pid in target_items:
            if pid not in self.item_to_idx:
                scores.append((pid, 0.0))
                continue
            i_idx = self.item_to_idx[pid]
            score = float(
                np.dot(u_emb, self.item_embeddings[i_idx]) +
                self.user_biases[u_idx] +
                self.item_biases[i_idx]
            )
            scores.append((pid, score))

        scores.sort(key=lambda x: x[1], reverse=True)
        return scores


def train_lightfm():
    # 1. Load data and features
    interactions_path = os.path.join(DATA_DIR, 'interactions.csv')
    features_path = os.path.join(DATA_DIR, 'item_features.npz')

    if not os.path.exists(interactions_path):
        try:
            from .build_dataset import build_dataset
        except (ImportError, ValueError):
            from build_dataset import build_dataset
        build_dataset()

    if not os.path.exists(features_path):
        try:
            from .build_features import build_features
        except (ImportError, ValueError):
            from build_features import build_features
        build_features()

    df_interactions = pd.read_csv(interactions_path)
    item_features = sparse.load_npz(features_path)

    print(f"[train_lightfm] Starting training on {len(df_interactions)} interactions...")

    # Train Hybrid WARP model
    model = SouqnaHybridRecommender(no_components=32, loss='warp', learning_rate=0.03, regularization=0.01)
    model.fit(df_interactions, item_features, epochs=25)

    os.makedirs(MODELS_DIR, exist_ok=True)
    model_version = "model_v1"
    artifact_path = os.path.join(MODELS_DIR, f"{model_version}.pkl")

    with open(artifact_path, 'wb') as f:
        pickle.dump(model, f)

    meta = {
        'modelVersion': model_version,
        'algorithm': 'LIGHTFM_WARP_HYBRID',
        'trainedAt': pd.Timestamp.now().isoformat(),
        'num_users': len(model.user_to_idx),
        'num_items': len(model.item_to_idx),
        'parameters': {
            'no_components': 32,
            'loss': 'warp',
            'learning_rate': 0.03,
            'regularization': 0.01,
            'epochs': 25
        }
    }
    with open(os.path.join(MODELS_DIR, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, indent=2)

    print(f"[train_lightfm] Successfully exported model to {artifact_path}")
    return model, meta


if __name__ == '__main__':
    from train_lightfm import train_lightfm as run_train
    run_train()
