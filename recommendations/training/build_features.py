"""
SOUQNAA — Recommendation Training Pipeline
Step 2: build_features.py
Extracts and engineers item metadata features (TF-IDF text tokens, category one-hot,
brand encoding, price buckets) into numerical matrices for LightFM and Content Similarity.
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import OneHotEncoder

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


def build_features():
    products_path = os.path.join(DATA_DIR, 'products.json')
    if not os.path.exists(products_path):
        try:
            from .build_dataset import build_dataset
        except (ImportError, ValueError):
            from build_dataset import build_dataset
        build_dataset()

    with open(products_path, 'r', encoding='utf-8') as f:
        products = json.load(f)

    df_products = pd.DataFrame(products)
    print(f"[build_features] Building features for {len(df_products)} products...")

    # 1. Text feature matrix using TF-IDF (Arabic & English)
    text_corpus = []
    for _, row in df_products.iterrows():
        title_en = str(row.get('nameEn') or '')
        title_ar = str(row.get('nameAr') or '')
        desc_en = str(row.get('descriptionEn') or '')
        desc_ar = str(row.get('descriptionAr') or '')
        text_corpus.append(f"{title_en} {title_ar} {desc_en} {desc_ar}")

    tfidf = TfidfVectorizer(max_features=100, stop_words='english')
    tfidf_matrix = tfidf.fit_transform(text_corpus)

    # 2. Categorical features: Category & Brand
    cat_brand_data = df_products[['categoryId', 'brandId']].fillna('UNKNOWN')
    encoder = OneHotEncoder(sparse_output=True, handle_unknown='ignore')
    cat_brand_matrix = encoder.fit_transform(cat_brand_data)

    # 3. Price buckets (0-500, 500-2000, 2000-5000, 5000+)
    price_bins = [0, 500, 2000, 5000, np.inf]
    price_labels = ['budget', 'mid', 'high', 'luxury']
    prices = df_products['price'].fillna(0.0)
    price_categories = pd.cut(prices, bins=price_bins, labels=price_labels)
    price_encoder = OneHotEncoder(sparse_output=True, handle_unknown='ignore')
    price_matrix = price_encoder.fit_transform(pd.DataFrame({'price_tier': price_categories}))

    # 4. Combine all features horizontally
    item_features = sparse.hstack([tfidf_matrix, cat_brand_matrix, price_matrix]).tocsr()
    print(f"[build_features] Final item feature matrix shape: {item_features.shape}")

    # Save feature matrices and mappings
    feature_meta = {
        'product_ids': df_products['id'].tolist(),
        'feature_dimension': item_features.shape[1],
        'tfidf_vocabulary': list(tfidf.vocabulary_.keys())[:20],
    }

    sparse.save_npz(os.path.join(DATA_DIR, 'item_features.npz'), item_features)
    with open(os.path.join(DATA_DIR, 'feature_meta.json'), 'w', encoding='utf-8') as f:
        json.dump(feature_meta, f, indent=2)

    print(f"[build_features] Saved item features to {os.path.join(DATA_DIR, 'item_features.npz')}")
    return item_features, df_products['id'].tolist()


if __name__ == '__main__':
    build_features()
