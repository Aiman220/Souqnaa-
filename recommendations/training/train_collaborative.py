"""
SOUQNAA — Recommendation Training Pipeline
Step 4: train_collaborative.py
Implicit Matrix Factorization / Alternating Least Squares (ALS) for implicit signals.
"""

import os
import sys
import pickle
import numpy as np
import pandas as pd

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


class ImplicitALSRecommender:
    def __init__(self, factors=32, regularization=0.1, iterations=15):
        self.factors = factors
        self.regularization = regularization
        self.iterations = iterations
        self.user_factors = None
        self.item_factors = None
        self.user_to_idx = {}
        self.item_to_idx = {}
        self.idx_to_item = {}

    def fit(self, df_interactions):
        unique_users = df_interactions['user_id'].unique().tolist()
        unique_items = df_interactions['product_id'].unique().tolist()

        self.user_to_idx = {u: i for i, u in enumerate(unique_users)}
        self.item_to_idx = {it: i for i, it in enumerate(unique_items)}
        self.idx_to_item = {i: it for it, i in self.item_to_idx.items()}

        num_users = len(unique_users)
        num_items = len(unique_items)

        print(
            f"[ALSRecommender] Fitting ALS on {num_users} users x "
            f"{num_items} items (rank={self.factors})..."
        )

        # Confidence matrix C_ui = 1 + alpha * R_ui
        np.random.seed(42)
        self.user_factors = np.random.normal(0, 0.1, (num_users, self.factors))
        self.item_factors = np.random.normal(0, 0.1, (num_items, self.factors))

        # Iterative alternating updates
        alpha = 40.0
        for it in range(self.iterations):
            # Update user factors
            yty = self.item_factors.T @ self.item_factors
            lambda_i = self.regularization * np.eye(self.factors)

            for u, group in df_interactions.groupby('user_id'):
                u_idx = self.user_to_idx[u]
                items_idx = [
                    self.item_to_idx[p]
                    for p in group['product_id']
                    if p in self.item_to_idx
                ]
                r = group['weight'].values
                c = 1.0 + alpha * r

                y_u = self.item_factors[items_idx]
                c_u_minus_i = c - 1.0

                a = yty + (y_u.T * c_u_minus_i) @ y_u + lambda_i
                b = (y_u.T * c) @ np.ones(len(items_idx))
                try:
                    self.user_factors[u_idx] = np.linalg.solve(a, b)
                except np.linalg.LinAlgError:
                    pass

            # Update item factors
            xtx = self.user_factors.T @ self.user_factors
            for p, group in df_interactions.groupby('product_id'):
                if p not in self.item_to_idx:
                    continue
                i_idx = self.item_to_idx[p]
                users_idx = [
                    self.user_to_idx[u]
                    for u in group['user_id']
                    if u in self.user_to_idx
                ]
                r = group['weight'].values
                c = 1.0 + alpha * r

                x_i = self.user_factors[users_idx]
                c_i_minus_i = c - 1.0

                a = xtx + (x_i.T * c_i_minus_i) @ x_i + lambda_i
                b = (x_i.T * c) @ np.ones(len(users_idx))
                try:
                    self.item_factors[i_idx] = np.linalg.solve(a, b)
                except np.linalg.LinAlgError:
                    pass

            print(f"[ALSRecommender] ALS Iteration {it + 1}/{self.iterations} completed.")

    def recommend(self, user_id, n=20):
        if user_id not in self.user_to_idx or self.user_factors is None or self.item_factors is None:
            return []
        u_idx = self.user_to_idx[user_id]
        scores = self.item_factors @ self.user_factors[u_idx]
        top_indices = np.argsort(scores)[::-1][:n]
        return [(self.idx_to_item[i], float(scores[i])) for i in top_indices]


def train_collaborative():
    interactions_path = os.path.join(DATA_DIR, 'interactions.csv')
    df_interactions = pd.read_csv(interactions_path)

    als = ImplicitALSRecommender(factors=32, regularization=0.05, iterations=10)
    als.fit(df_interactions)

    artifact_path = os.path.join(MODELS_DIR, 'collaborative_als.pkl')
    with open(artifact_path, 'wb') as f:
        pickle.dump(als, f)

    print(f"[train_collaborative] Exported ALS model to {artifact_path}")
    return als


if __name__ == '__main__':
    from train_collaborative import train_collaborative as run_train
    run_train()
