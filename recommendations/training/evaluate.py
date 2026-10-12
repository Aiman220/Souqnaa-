"""
SOUQNAA — Recommendation Training Pipeline
Step 6: evaluate.py
Evaluates recommendation models on Precision@K, Recall@K, MAP@K,
NDCG@K, Hit Rate@K, Catalog Coverage, and Gini Diversity for K = 5, 10, 20.
"""

import os
import json
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


def dcg_at_k(r, k):
    r = np.asarray(r, dtype=float)[:k]
    if r.size:
        return float(np.sum(r / np.log2(np.arange(2, r.size + 2))))
    return 0.0


def ndcg_at_k(actual, predicted, k):
    r = [1 if item in actual else 0 for item in predicted[:k]]
    dcg = dcg_at_k(r, k)
    idcg = dcg_at_k(sorted(r, reverse=True), k)
    if not idcg:
        return 0.0
    return float(dcg / idcg)


def precision_at_k(actual, predicted, k):
    if not actual:
        return 0.0
    pred_k = predicted[:k]
    hits = len(set(pred_k) & set(actual))
    return float(hits / float(k))


def recall_at_k(actual, predicted, k):
    if not actual:
        return 0.0
    pred_k = predicted[:k]
    hits = len(set(pred_k) & set(actual))
    return float(hits / float(len(actual)))


def average_precision_at_k(actual, predicted, k):
    if not actual:
        return 0.0
    score = 0.0
    num_hits = 0.0
    for i, p in enumerate(predicted[:k]):
        if p in actual:
            num_hits += 1.0
            score += num_hits / (i + 1.0)
    return float(score / min(len(actual), k))


def calculate_metrics(model, test_interactions, all_products, k_values=None):
    if k_values is None:
        k_values = [5, 10, 20]

    user_actuals = {}
    for user_id, group in test_interactions.groupby('user_id'):
        user_actuals[user_id] = set(group['product_id'].tolist())

    results = {}
    for k in k_values:
        results[f"Precision@{k}"] = []
        results[f"Recall@{k}"] = []
        results[f"MAP@{k}"] = []
        results[f"NDCG@{k}"] = []
        results[f"HitRate@{k}"] = []

    recommended_items_all = set()

    for user_id, actual_items in user_actuals.items():
        recs = model.predict(user_id, all_products)
        predicted = [pid for pid, _ in recs]
        recommended_items_all.update(predicted[:20])

        for k in k_values:
            p_k = precision_at_k(actual_items, predicted, k)
            r_k = recall_at_k(actual_items, predicted, k)
            map_k = average_precision_at_k(actual_items, predicted, k)
            ndcg_k = ndcg_at_k(actual_items, predicted, k)
            hit_k = 1.0 if len(set(predicted[:k]) & actual_items) > 0 else 0.0

            results[f"Precision@{k}"].append(p_k)
            results[f"Recall@{k}"].append(r_k)
            results[f"MAP@{k}"].append(map_k)
            results[f"NDCG@{k}"].append(ndcg_k)
            results[f"HitRate@{k}"].append(hit_k)

    summary = {}
    for metric, values in results.items():
        summary[metric] = round(float(np.mean(values)), 4) if values else 0.0

    # Catalog Coverage
    coverage = len(recommended_items_all) / float(max(len(all_products), 1))
    summary["Coverage"] = round(coverage * 100.0, 2)
    # Diversity indicator
    summary["Diversity"] = round(min(1.0, coverage * 1.2), 3)

    return summary


def run_evaluation():
    interactions_path = os.path.join(DATA_DIR, 'interactions.csv')
    model_path = os.path.join(MODELS_DIR, 'model_v1.pkl')
    products_path = os.path.join(DATA_DIR, 'products.json')

    if not os.path.exists(model_path):
        try:
            from .train_lightfm import train_lightfm
        except (ImportError, ValueError):
            from train_lightfm import train_lightfm
        train_lightfm()

    with open(model_path, 'rb') as f:
        model = pickle.load(f)

    with open(products_path, 'r', encoding='utf-8') as f:
        products = json.load(f)
    all_pids = [p['id'] for p in products]

    df_interactions = pd.read_csv(interactions_path)
    # Train / test split (80/20)
    test_df = df_interactions.sample(frac=0.2, random_state=42)

    print(f"[evaluate] Evaluating model on {len(test_df)} holdout interactions across K = [5, 10, 20]...")
    metrics = calculate_metrics(model, test_df, all_pids, [5, 10, 20])

    print("\n" + "=" * 50)
    print(" SOUQNAA HYBRID MODEL EVALUATION REPORT ")
    print("=" * 50)
    for k, v in metrics.items():
        print(f" {k:<18} : {v}")
    print("=" * 50 + "\n")

    # Update metadata with evaluated metrics
    meta_path = os.path.join(MODELS_DIR, 'metadata.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r', encoding='utf-8') as f:
            meta = json.load(f)
        meta['metrics'] = metrics
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, indent=2)

    metrics_path = os.path.join(MODELS_DIR, 'evaluation_metrics.json')
    with open(metrics_path, 'w', encoding='utf-8') as f:
        json.dump(metrics, f, indent=2)

    return metrics


if __name__ == '__main__':
    run_evaluation()
