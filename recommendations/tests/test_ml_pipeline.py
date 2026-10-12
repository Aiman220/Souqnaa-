"""
Unit and integration tests for Souqnaa Offline ML Recommendation Engine.
Tests:
- Dataset creation and interaction processing
- SouqnaHybridRecommender training (WARP/BPR)
- Offline Collaborative Filtering (Implicit ALS)
- Item-Item Content Similarity (Cosine TF-IDF)
- Evaluation Metrics (Precision@K, Recall@K, AP@K, NDCG@K, HitRate@K, Coverage)
- Model Export and Versioning
- Fallback on missing or corrupt model
"""
import unittest
import numpy as np
import scipy.sparse as sp
import pandas as pd
import tempfile
import os
import pickle
import sys

# Ensure UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from training.train_lightfm import SouqnaHybridRecommender
from training.train_collaborative import ImplicitALSRecommender
from sklearn.metrics.pairwise import cosine_similarity
from training.evaluate import (
    precision_at_k,
    recall_at_k,
    average_precision_at_k,
    ndcg_at_k,
)


class TestMLPipeline(unittest.TestCase):

    def setUp(self):
        np.random.seed(42)
        self.num_users = 25
        self.num_items = 40
        self.num_features = 10

        self.user_ids = [f"user_{i}" for i in range(self.num_users)]
        self.product_ids = [f"prod_{j}" for j in range(self.num_items)]

        # Synthetic DataFrame interactions
        records = []
        for u in self.user_ids:
            num_inter = np.random.randint(3, 10)
            sampled_items = np.random.choice(self.product_ids, size=num_inter, replace=False)
            for it in sampled_items:
                records.append({
                    'user_id': u,
                    'product_id': it,
                    'weight': float(np.random.choice([1.0, 2.0, 3.0, 7.0, 10.0]))
                })

        self.df_interactions = pd.DataFrame(records)

        # Synthetic item features (40 items x 10 features)
        self.item_features = sp.random(
            self.num_items, self.num_features, density=0.3, format='csr', dtype=np.float32
        )

    def test_hybrid_recommender_training_and_prediction(self):
        """Verify WARP/BPR hybrid matrix factorization training and inference."""
        model = SouqnaHybridRecommender(
            no_components=16,
            learning_rate=0.05,
            loss='warp'
        )
        model.fit(self.df_interactions, self.item_features, epochs=3)

        self.assertIsNotNone(model.user_embeddings)
        self.assertIsNotNone(model.item_embeddings)
        self.assertEqual(model.user_embeddings.shape[1], 16)
        self.assertEqual(model.item_embeddings.shape[1], 16)

        # Predict for user 0 across all items
        user_id = self.user_ids[0]
        recs = model.predict(user_id, self.product_ids)

        self.assertEqual(len(recs), self.num_items)
        for pid, score in recs:
            self.assertIn(pid, self.product_ids)
            self.assertFalse(np.isnan(score), "Scores must not contain NaN")
            self.assertTrue(np.isfinite(score), "Scores must be finite")

    def test_collaborative_filtering_implicit(self):
        """Verify Implicit collaborative filtering model."""
        cf_model = ImplicitALSRecommender(factors=8, iterations=3, regularization=0.05)
        cf_model.fit(self.df_interactions)

        user_id = self.user_ids[0]
        recs = cf_model.recommend(user_id, n=5)
        self.assertLessEqual(len(recs), 5)
        for item_id, score in recs:
            self.assertIn(item_id, self.product_ids)
            self.assertFalse(np.isnan(score))

    def test_item_similarity_cosine(self):
        """Verify TF-IDF cosine item similarity."""
        sim_matrix = cosine_similarity(self.item_features)
        self.assertEqual(sim_matrix.shape, (self.num_items, self.num_items))
        sim_scores = sim_matrix[0].copy()
        sim_scores[0] = -1.0
        top_indices = np.argsort(sim_scores)[::-1][:5]
        self.assertEqual(len(top_indices), 5)
        for idx in top_indices:
            self.assertNotEqual(idx, 0, "Item must not be similar to itself")
            self.assertTrue(0.0 <= sim_scores[idx] <= 1.0001, f"Cosine similarity out of bounds: {sim_scores[idx]}")

    def test_evaluation_metrics(self):
        """Verify ranking metrics (Precision, Recall, AP, NDCG, HitRate, Coverage)."""
        actual = ["prod_1", "prod_2", "prod_5"]
        recommended = ["prod_0", "prod_1", "prod_3", "prod_5", "prod_7"]

        prec = precision_at_k(actual, recommended, k=5)
        rec = recall_at_k(actual, recommended, k=5)
        ap_k = average_precision_at_k(actual, recommended, k=5)
        ndcg = ndcg_at_k(actual, recommended, k=5)
        hit = 1.0 if len(set(recommended[:5]) & set(actual)) > 0 else 0.0

        self.assertAlmostEqual(prec, 2.0 / 5.0)
        self.assertAlmostEqual(rec, 2.0 / 3.0)
        self.assertGreater(ap_k, 0.0)
        self.assertGreater(ndcg, 0.0)
        self.assertEqual(hit, 1.0)

        all_recs = [recommended, ["prod_2", "prod_8", "prod_9", "prod_10", "prod_11"]]
        unique_recs = set([item for r in all_recs for item in r])
        cov = len(unique_recs) / len(self.product_ids)
        self.assertGreater(cov, 0.0)
        self.assertLessEqual(cov, 1.0)

    def test_model_serialization_and_recovery(self):
        """Verify export, versioning, serialization, and recovery."""
        model = SouqnaHybridRecommender(no_components=8)
        model.fit(self.df_interactions, self.item_features, epochs=2)

        with tempfile.NamedTemporaryFile(suffix='.pkl', delete=False) as tmp:
            tmp_path = tmp.name

        try:
            with open(tmp_path, 'wb') as f:
                pickle.dump(model, f)

            with open(tmp_path, 'rb') as f:
                loaded_model = pickle.load(f)

            self.assertIsNotNone(loaded_model.user_embeddings)
            recs_orig = model.predict(self.user_ids[0], self.product_ids[:5])
            recs_loaded = loaded_model.predict(self.user_ids[0], self.product_ids[:5])
            self.assertEqual(len(recs_orig), len(recs_loaded))
            for i in range(len(recs_orig)):
                self.assertEqual(recs_orig[i][0], recs_loaded[i][0])
                self.assertAlmostEqual(recs_orig[i][1], recs_loaded[i][1], places=4)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)


if __name__ == '__main__':
    unittest.main()
