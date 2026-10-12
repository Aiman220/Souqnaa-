"""
SOUQNAA — Recommendation Training Pipeline
Step 1: build_dataset.py
Extracts marketplace interactions, orders, and product catalog metadata from PostgreSQL,
applies event weighting and half-life time decay, and prepares interaction matrices.
"""

import os
import sys
import json
import math
from datetime import datetime, timezone
import pandas as pd
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
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

raw_db_url = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/souqna_db")
DATABASE_URL = raw_db_url.split('?')[0] if raw_db_url else ""

DEFAULT_WEIGHTS = {
    'PURCHASE': 10.0,
    'ORDER_COMPLETED': 10.0,
    'ADD_TO_CART': 7.0,
    'REMOVE_FROM_CART': -2.0,
    'ADD_TO_WISHLIST': 6.0,
    'REMOVE_FROM_WISHLIST': -1.0,
    'PRODUCT_CLICK': 3.0,
    'PRODUCT_VIEW': 2.0,
    'SEARCH_RESULT_CLICK': 2.0,
    'PRODUCT_SHARE': 2.0,
    'PRODUCT_REVIEW': 2.0,
    'PRODUCT_RATING': 2.0,
    'CATEGORY_VIEW': 1.0,
    'SELLER_VIEW': 1.0,
    'FOLLOW_SELLER': 3.0,
    'FLASH_SALE_CLICK': 3.0,
    'CAMPAIGN_CLICK': 3.0,
}

HALF_LIFE_DAYS = {
    'PRODUCT_VIEW': 7.0,
    'PRODUCT_CLICK': 7.0,
    'ADD_TO_CART': 14.0,
    'ADD_TO_WISHLIST': 14.0,
    'PURCHASE': 30.0,
    'DEFAULT': 14.0,
}


def get_time_decay(event_time, event_type, now):
    if not event_time:
        return 1.0
    if isinstance(event_time, str):
        event_time = datetime.fromisoformat(event_time)
    if event_time.tzinfo is None:
        event_time = event_time.replace(tzinfo=timezone.utc)

    age_days = max(0.0, (now - event_time).total_seconds() / 86400.0)
    hl = HALF_LIFE_DAYS.get(event_type, HALF_LIFE_DAYS['DEFAULT'])
    return math.pow(0.5, age_days / hl)


def generate_synthetic_data():
    """Generates deterministic marketplace bootstrap data if DB is empty."""
    print("[build_dataset] Generating bootstrap marketplace data...")
    categories = ['cat_electronics', 'cat_fashion', 'cat_home', 'cat_beauty', 'cat_sports']
    brands = ['brand_apple', 'brand_samsung', 'brand_nike', 'brand_sony', 'brand_zara']
    sellers = ['seller_tech_hub', 'seller_fashion_world', 'seller_yemen_store']

    products = []
    for i in range(1, 51):
        p_id = f"prod_{i:03d}"
        cat_id = categories[i % len(categories)]
        brand_id = brands[i % len(brands)]
        seller_id = sellers[i % len(sellers)]
        price = 50.0 + (i * 25.0) % 1500.0
        products.append({
            'id': p_id,
            'nameEn': f"Product {i} Premium Quality",
            'nameAr': f"منتج {i} عالي الجودة",
            'descriptionEn': f"High performance genuine marketplace product {i}",
            'descriptionAr': f"منتج أصلي عالي الأداء والمواصفات {i}",
            'categoryId': cat_id,
            'brandId': brand_id,
            'storeId': seller_id,
            'price': price,
            'rating': 4.0 + (i % 10) * 0.1,
            'reviewCount': 10 + i * 3,
            'soldCount': 20 + i * 5,
            'createdAt': datetime.now(timezone.utc).isoformat()
        })

    events = []
    event_types = ['PRODUCT_VIEW', 'PRODUCT_CLICK', 'ADD_TO_CART', 'ADD_TO_WISHLIST', 'PURCHASE']
    np.random.seed(42)
    for u in range(1, 31):
        u_id = f"user_{u:03d}"
        # Each user has category preferences
        preferred_cat = categories[u % len(categories)]
        user_prods = [p['id'] for p in products if p['categoryId'] == preferred_cat]
        other_prods = [p['id'] for p in products if p['categoryId'] != preferred_cat]

        for _ in range(15):
            pid = np.random.choice(user_prods if np.random.rand() < 0.7 else other_prods)
            etype = str(np.random.choice(event_types, p=[0.4, 0.25, 0.15, 0.1, 0.1]))
            events.append({
                'id': f"evt_{len(events)}",
                'userId': u_id,
                'sessionId': f"sess_{u:03d}",
                'eventType': etype,
                'productId': pid,
                'timestamp': datetime.now(timezone.utc).isoformat()
            })

    return products, events


def fetch_data_from_db():
    print("[build_dataset] Connecting to PostgreSQL...")
    conn = None
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cursor = conn.cursor(cursor_factory=RealDictCursor)

        # 1. Fetch active products
        cursor.execute("""
            SELECT p.id, p."nameEn", p."nameAr", p."descriptionEn", p."descriptionAr",
                   p."categoryId", p."brandId", p."storeId", p.price, p.rating,
                   p."reviewCount", p."soldCount", p."createdAt"
            FROM "souqna"."Product" p
            WHERE p."isActive" = true AND p."isSuspended" = false
        """)
        products = cursor.fetchall()
        print(f"[build_dataset] Fetched {len(products)} products from DB.")

        # 2. Fetch events
        cursor.execute("""
            SELECT "id", "userId", "sessionId", "eventType", "productId", "categoryId", "sellerId", "timestamp"
            FROM "souqna"."RecommendationEvent"
            WHERE "productId" IS NOT NULL
            ORDER BY "timestamp" DESC
            LIMIT 50000
        """)
        events = cursor.fetchall()
        print(f"[build_dataset] Fetched {len(events)} events from DB.")

        return products, events
    except Exception as e:
        print(f"[build_dataset] Warning: DB fetch failed ({e}). Using synthetic marketplace data.")
        return generate_synthetic_data()
    finally:
        if conn:
            conn.close()


def build_dataset():
    products, events = fetch_data_from_db()
    if not products:
        products, events = generate_synthetic_data()

    now = datetime.now(timezone.utc)

    # Build interactions dataframe
    records = []
    for evt in events:
        pid = evt.get('productId')
        uid = evt.get('userId') or evt.get('sessionId')
        etype = evt.get('eventType')
        ts = evt.get('timestamp')

        if not pid or not uid:
            continue

        base_weight = DEFAULT_WEIGHTS.get(etype, 1.0)
        decay = get_time_decay(ts, etype, now)
        final_weight = base_weight * decay

        records.append({
            'user_id': str(uid),
            'product_id': str(pid),
            'event_type': etype,
            'weight': final_weight,
            'timestamp': str(ts)
        })

    df_interactions = pd.DataFrame(records)
    if not df_interactions.empty:
        df_aggregated = df_interactions.groupby(['user_id', 'product_id'])['weight'].sum().reset_index()
    else:
        df_aggregated = pd.DataFrame(columns=['user_id', 'product_id', 'weight'])

    df_products = pd.DataFrame(products)

    os.makedirs(os.path.join(OUTPUT_DIR, '../data'), exist_ok=True)
    interactions_path = os.path.join(OUTPUT_DIR, '../data/interactions.csv')
    products_path = os.path.join(OUTPUT_DIR, '../data/products.json')

    df_aggregated.to_csv(interactions_path, index=False)
    with open(products_path, 'w', encoding='utf-8') as f:
        json.dump(products, f, ensure_ascii=False, indent=2, default=str)

    print(f"[build_dataset] Successfully saved {len(df_aggregated)} interactions to {interactions_path}")
    print(f"[build_dataset] Successfully saved {len(df_products)} products to {products_path}")
    return df_aggregated, df_products


if __name__ == '__main__':
    build_dataset()
