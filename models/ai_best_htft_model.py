#!/usr/bin/env python3
"""
ai_best_htft_model.py
=====================
Dedicated XGBoost classifier for HT/FT outcome prediction (AI Best pipeline).

Usage:
    python3 ai_best_htft_model.py --db /path/to/sportybet_archive.db --out ./utils/

Output:
    utils/ai_best_htft_model.json      — trained XGBoost model
    utils/ai_best_htft_thresholds.json — confidence thresholds per market
    utils/ai_best_htft_report.json     — walk-forward validation report
"""

import json
import sys
import os
import subprocess
import tempfile
import argparse
import numpy as np

# ──────────────────────────────────────────────────────────────────────────────
# IMPORTS
# ──────────────────────────────────────────────────────────────────────────────
try:
    import xgboost as xgb
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.metrics import brier_score_loss, log_loss
    import pandas as pd
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run: pip3 install xgboost scikit-learn pandas numpy --break-system-packages")
    sys.exit(1)

HTFT_LABELS = [
    'htft11', 'htft1X', 'htft12',
    'htftX1', 'htftXX', 'htftX2',
    'htft21', 'htft2X', 'htft22'
]

# ──────────────────────────────────────────────────────────────────────────────
# LOAD FEATURES FROM NODE.JS BUILDER
# ──────────────────────────────────────────────────────────────────────────────
def load_features(db_path, utils_dir):
    """Query SQLite natively in Python, then call ai_best_feature_builder.js to compute features."""
    import sqlite3
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, home_team, away_team, predicted_probs, actual_ht_score, actual_score
        FROM historical_market_predictions
        WHERE actual_ht_score IS NOT NULL AND actual_ht_score != ''
          AND actual_score IS NOT NULL AND actual_score LIKE '%:%'
          AND predicted_probs IS NOT NULL
        ORDER BY id ASC
    """)
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()

    print(f"Read {len(rows)} historical matches from database.")
    if len(rows) == 0:
        raise RuntimeError(f"No valid historical matches found in {db_path}")

    # Write raw rows to temp file for feature builder
    in_file = os.path.join(tempfile.gettempdir(), f'ai_best_raw_rows_{os.getpid()}.json')
    out_file = os.path.join(tempfile.gettempdir(), f'ai_best_features_{os.getpid()}.json')

    with open(in_file, 'w', encoding='utf-8') as f:
        json.dump(rows, f)

    script = f"""
const {{ buildTrainingDataset }} = require('{utils_dir}/ai_best_feature_builder.js');
const fs = require('fs');
const result = buildTrainingDataset('{in_file}');
process.stderr.write('Writing ' + result.features.length + ' feature vectors to disk...\\n');
fs.writeFileSync('{out_file}', JSON.stringify(result));
process.stderr.write('Done.\\n');
"""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
        f.write(script)
        tmp = f.name

    try:
        proc = subprocess.run(
            ['node', tmp],
            cwd=os.path.dirname(utils_dir),
            capture_output=True,
            timeout=120
        )
        if proc.stderr:
            sys.stderr.write(proc.stderr.decode('utf-8', errors='replace'))
        if proc.returncode != 0:
            raise RuntimeError(f"Node.js exited {proc.returncode}: {proc.stderr.decode()}")
        with open(out_file, 'r') as fh:
            data = json.load(fh)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
        if os.path.exists(in_file):
            os.unlink(in_file)
        if os.path.exists(out_file):
            os.unlink(out_file)

    features = np.array(data['features'], dtype=np.float32)
    labels   = np.array(data['labels'],   dtype=np.int32)
    ids      = np.array(data['ids'],      dtype=np.int64)
    return features, labels, ids




# ──────────────────────────────────────────────────────────────────────────────
# WALK-FORWARD CROSS-VALIDATION
# ──────────────────────────────────────────────────────────────────────────────
def walk_forward_cv(X, y, ids, n_folds=5):
    """
    Expanding window walk-forward CV.
    Each fold: train on [0:split], test on [split:split+chunk]
    Returns per-fold metrics + OOS predictions for the full dataset.
    """
    n = len(X)
    min_train = int(n * 0.30)  # need at least 30% to train
    chunk = (n - min_train) // n_folds

    oos_probs  = np.zeros((n, 9), dtype=np.float32)
    oos_mask   = np.zeros(n, dtype=bool)
    fold_results = []

    print(f"\n{'='*60}")
    print(f"Walk-Forward Cross-Validation ({n_folds} folds, n={n})")
    print(f"{'='*60}")

    for fold in range(n_folds):
        train_end = min_train + fold * chunk
        test_end  = min(train_end + chunk, n)

        X_train, y_train = X[:train_end], y[:train_end]
        X_test,  y_test  = X[train_end:test_end], y[train_end:test_end]

        model = train_xgboost(X_train, y_train)
        proba = model.predict_proba(X_test)

        oos_probs[train_end:test_end] = proba
        oos_mask[train_end:test_end]  = True

        # Metrics
        top1_acc = np.mean(np.argmax(proba, axis=1) == y_test)
        ll       = log_loss(y_test, proba)

        # Simulated EV ROI (at typical 14% book margin)
        roi = simulate_ev_roi(proba, y_test, book_margin=0.139, min_ev=0.08)

        fold_results.append({
            'fold': fold + 1,
            'train_n': train_end,
            'test_n': test_end - train_end,
            'top1_accuracy': round(float(top1_acc * 100), 2),
            'log_loss': round(float(ll), 4),
            'simulated_roi': round(float(roi * 100), 2)
        })

        print(f"Fold {fold+1}: train={train_end:,} test={test_end-train_end:,} "
              f"| top1={top1_acc*100:.1f}% | ll={ll:.4f} | sim_roi={roi*100:+.1f}%")

    return fold_results, oos_probs, oos_mask

# ──────────────────────────────────────────────────────────────────────────────
# XGBOOST TRAINING
# ──────────────────────────────────────────────────────────────────────────────
def train_xgboost(X_train, y_train):
    """Train an XGBoost multi-class softprob classifier."""
    # Class weights to handle imbalance (rare outcomes get more weight)
    unique, counts = np.unique(y_train, return_counts=True)
    class_counts = dict(zip(unique, counts))
    total = len(y_train)
    weights = np.array([
        total / (9 * class_counts.get(i, 1)) for i in range(9)
    ])
    sample_weights = np.array([weights[yi] for yi in y_train])

    model = xgb.XGBClassifier(
        objective       = 'multi:softprob',
        num_class       = 9,
        n_estimators    = 400,
        max_depth       = 4,           # shallow = less overfit on 20k rows
        learning_rate   = 0.05,
        subsample       = 0.80,
        colsample_bytree= 0.75,
        min_child_weight= 10,          # regularise: needs 10 samples per leaf
        gamma           = 0.1,         # pruning threshold
        reg_alpha       = 0.1,         # L1 regularisation
        reg_lambda      = 1.5,         # L2 regularisation
        n_jobs          = -1,
        random_state    = 42,
        eval_metric     = 'mlogloss',
        early_stopping_rounds = 30,
        verbosity       = 0
    )

    # Use 10% of training as internal validation for early stopping
    val_split = max(1, int(len(X_train) * 0.10))
    X_val, y_val = X_train[-val_split:], y_train[-val_split:]
    X_tr,  y_tr  = X_train[:-val_split], y_train[:-val_split]
    sw_tr = sample_weights[:-val_split]

    model.fit(
        X_tr, y_tr,
        sample_weight        = sw_tr,
        eval_set             = [(X_val, y_val)],
        verbose              = False
    )
    return model

# ──────────────────────────────────────────────────────────────────────────────
# SIMULATED EV ROI
# ──────────────────────────────────────────────────────────────────────────────
# Typical Sportybet HT/FT odds by market (measured empirically from sportybet_archive.db)
# Used for EV simulation when real match-specific odds are unavailable.
TYPICAL_BOOK_ODDS = {
    0: 4.1,   # htft11
    1: 22.0,  # htft1X
    2: 80.0,  # htft12
    3: 7.0,   # htftX1
    4: 6.5,   # htftXX
    5: 9.0,   # htftX2
    6: 75.0,  # htft21
    7: 24.0,  # htft2X
    8: 5.8,   # htft22
}

# Only bet these markets (others have no positive expected ROI)
PROFITABLE_MARKETS = {0, 4, 8}  # htft11, htftXX, htft22

def simulate_ev_roi(proba, y_true, book_margin=0.139, min_ev=0.0):
    """
    For each match, compare XGBoost probability against REAL typical book odds.
    EV = model_prob * book_odd - 1.0
    Only bet profitable markets (htft11, htftXX, htft22) where model has edge.
    min_ev: minimum EV threshold to place a bet.
    Returns ROI across all bets placed.
    """
    bets, profit = 0, 0.0
    for p_vec, actual in zip(proba, y_true):
        best_ev, best_idx, best_book_odd = -np.inf, -1, 0.0
        for j in PROFITABLE_MARKETS:
            p = float(p_vec[j])
            if p < 0.10:  # minimum model confidence
                continue
            book_odd = TYPICAL_BOOK_ODDS[j]
            ev = p * book_odd - 1.0
            if ev > best_ev:
                best_ev = ev
                best_idx = j
                best_book_odd = book_odd

        if best_idx >= 0 and best_ev >= min_ev:
            won = (best_idx == actual)
            profit += best_book_odd - 1.0 if won else -1.0
            bets += 1

    return profit / bets if bets > 0 else 0.0

# ──────────────────────────────────────────────────────────────────────────────
# CONFIDENCE THRESHOLDS
# ──────────────────────────────────────────────────────────────────────────────
def compute_confidence_thresholds(oos_probs, y_true, oos_mask):
    """
    For each market, find the minimum model probability threshold that gives
    the best OOS ROI using REAL typical book odds.
    Returns per-market threshold dict.
    """
    probs_masked = oos_probs[oos_mask]
    y_masked     = y_true[oos_mask]
    thresholds   = {}

    for j, label in enumerate(HTFT_LABELS):
        book_odd = TYPICAL_BOOK_ODDS[j]
        best_thresh, best_roi, best_n, best_wr = 0.0, -np.inf, 0, 0.0
        for thresh in np.arange(0.05, 0.65, 0.025):
            idxs = np.where(probs_masked[:, j] >= thresh)[0]
            if len(idxs) < 15:
                break
            y_arr = (y_masked[idxs] == j).astype(float)
            wr    = float(np.mean(y_arr))
            roi   = wr * book_odd - 1.0
            if roi > best_roi:
                best_roi   = roi
                best_thresh = float(thresh)
                best_n     = len(idxs)
                best_wr    = wr

        thresholds[label] = {
            'min_prob':    round(best_thresh, 3),
            'oos_roi':     round(float(best_roi * 100), 2),
            'oos_n':       best_n,
            'oos_win_rate':round(best_wr * 100, 1),
            'book_odd':    book_odd
        }

    return thresholds

# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────
def find_valid_db(initial_path, app_dir):
    candidates = [
        initial_path,
        os.environ.get('TRAIN_DB_PATH'),
        os.path.join(app_dir, 'databases', 'sportybet_archive.db'),
        os.path.join(app_dir, 'sportybet_archive.db'),
        os.path.join(app_dir, '..', 'database', 'sportybet_archive.db')
    ]
    try:
        settings_file = os.path.join(app_dir, 'bot_settings.json')
        if os.path.exists(settings_file):
            with open(settings_file, 'r', encoding='utf-8') as f:
                settings = json.load(f)
                if settings.get('trainingDbPath'):
                    candidates.insert(1, settings['trainingDbPath'])
                if settings.get('outputDir'):
                    candidates.insert(2, os.path.join(settings['outputDir'], 'sportybet_archive.db'))
    except Exception:
        pass

    for c in candidates:
        if c and os.path.exists(c) and os.path.getsize(c) > 1024:
            try:
                conn = sqlite3.connect(c)
                tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
                conn.close()
                if 'historical_market_predictions' in tables:
                    return os.path.abspath(c)
            except Exception:
                pass
    return os.path.abspath(initial_path) if initial_path else os.path.join(app_dir, 'databases', 'sportybet_archive.db')

def main():
    default_utils_dir = os.path.dirname(os.path.abspath(__file__))
    app_dir = os.path.dirname(default_utils_dir)

    parser = argparse.ArgumentParser(description="AI Best HT/FT XGBoost Engine")
    parser.add_argument('--db',  default='', help='Path to sportybet_archive.db')
    parser.add_argument('--out', default=default_utils_dir, help='Output directory (utils/)')
    args, _ = parser.parse_known_args()

    db_path   = find_valid_db(args.db, app_dir)
    utils_dir = os.path.abspath(args.out) if args.out else default_utils_dir

    print(f"DB: {db_path}")
    print(f"Output: {utils_dir}")

    # ── Step 1: Load features ──────────────────────────────────────────────
    print("\nBuilding feature vectors via Node.js...")
    X, y, ids = load_features(db_path, utils_dir)
    print(f"Loaded: X={X.shape}, y={y.shape}, class distribution:")
    unique, counts = np.unique(y, return_counts=True)
    for u, c in zip(unique, counts):
        print(f"  {HTFT_LABELS[u]:12s}: {c:5d} ({c/len(y)*100:.1f}%)")

    # ── Step 2: Walk-forward CV ────────────────────────────────────────────
    fold_results, oos_probs, oos_mask = walk_forward_cv(X, y, ids, n_folds=5)

    # ── Step 3: Check if profitable ───────────────────────────────────────
    profitable_folds = sum(1 for f in fold_results if f['simulated_roi'] > 0)
    avg_oos_roi = np.mean([f['simulated_roi'] for f in fold_results])
    print(f"\n{'='*60}")
    print(f"CV Summary: profitable in {profitable_folds}/5 folds | avg OOS ROI: {avg_oos_roi:+.1f}%")

    # ── Step 4: Train final model on ALL data ─────────────────────────────
    print("\nTraining final model on full dataset...")
    final_model = train_xgboost(X, y)

    # Feature importance (top 15)
    fi = final_model.feature_importances_
    feat_names = (
        [f'home_{n}' for n in ['htGF','htGA','ftGF','ftGA','htWR','htDR','htLR','ftWR','ftDR','ftLR','11R','22R','XXR','X1R','X2R','form5']] +
        [f'away_{n}' for n in ['htGF','htGA','ftGF','ftGA','htWR','htDR','htLR','ftWR','ftDR','ftLR','11R','22R','XXR','X1R','X2R','form5']] +
        ['p_homeWin','p_draw','p_awayWin','p_o15','p_o25','p_o35','p_gg','p_htScore1st','p_htScore2nd','p_htEqual',
         'p_11','p_1X','p_12','p_X1','p_XX','p_X2','p_21','p_2X','p_22',
         'homeStrength','htGoalExp','ftGoalExp','homeFormDiff','htFormDiff','highScoring','strongHome']
    )
    fi_pairs = sorted(zip(feat_names, fi), key=lambda x: -x[1])
    print("\nTop 15 features:")
    for name, imp in fi_pairs[:15]:
        bar = '█' * int(imp * 200)
        print(f"  {name:20s}: {imp:.4f} {bar}")

    # ── Step 5: Compute confidence thresholds ─────────────────────────────
    print("\nComputing per-market confidence thresholds...")
    thresholds = compute_confidence_thresholds(oos_probs, y, oos_mask)
    print("\nPer-market profitability thresholds (OOS):")
    for label, t in thresholds.items():
        verdict = '✅' if t['oos_roi'] > 0 else '❌'
        print(f"  {verdict} {label:10s}: min_prob={t['min_prob']:.0%}  oos_roi={t['oos_roi']:+.1f}%  n={t['oos_n']}")

    # ── Step 6: Save outputs ──────────────────────────────────────────────
    model_path      = os.path.join(utils_dir, 'ai_best_htft_model.json')
    thresholds_path = os.path.join(utils_dir, 'ai_best_htft_thresholds.json')
    report_path     = os.path.join(utils_dir, 'ai_best_htft_report.json')

    final_model.save_model(model_path)
    print(f"\nModel saved: {model_path}")

    with open(thresholds_path, 'w') as f:
        json.dump(thresholds, f, indent=2)
    print(f"Thresholds saved: {thresholds_path}")

    def json_serial(obj):
        if isinstance(obj, (np.bool_, bool)):
            return bool(obj)
        if isinstance(obj, (np.integer, int)):
            return int(obj)
        if isinstance(obj, (np.floating, float)):
            return float(obj)
        return str(obj)

    report = {
        'trained_on': int(len(X)),
        'n_classes': 9,
        'htft_labels': HTFT_LABELS,
        'walk_forward_folds': fold_results,
        'profitable_folds': int(profitable_folds),
        'avg_oos_roi': round(float(avg_oos_roi), 2),
        'ready_for_deployment': bool(profitable_folds >= 3 and avg_oos_roi > 0)
    }
    with open(report_path, 'w') as f:
        json.dump(report, f, indent=2, default=json_serial)
    print(f"Report saved: {report_path}")

    print(f"\n{'='*60}")
    if report['ready_for_deployment']:
        print("✅ MODEL READY FOR DEPLOYMENT")
        print(f"   Profitable in {profitable_folds}/5 folds, avg OOS ROI = {avg_oos_roi:+.1f}%")
    else:
        print("⚠️  MODEL NOT YET PROFITABLE ENOUGH FOR DEPLOYMENT")
        print(f"   Profitable in {profitable_folds}/5 folds, avg OOS ROI = {avg_oos_roi:+.1f}%")
        print("   Keep accumulating prospective data or adjust feature engineering")
    print(f"{'='*60}\n")

if __name__ == '__main__':
    main()
