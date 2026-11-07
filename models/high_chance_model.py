#!/usr/bin/env python3
"""
High Chance Pick XGBoost Engine — Training Script
==================================================
Completely separate engine from AI Best and Safest.

Target markets: Over 2.5 Goals, BTTS (GG) — the only consistently profitable
high-odds markets found in prospective testing.

Label per match:
  - over25_label: 1 if actual total goals > 2, 0 otherwise
  - gg_label:     1 if both teams scored, 0 otherwise

Two separate XGBoost binary classifiers, one per market.
Picks the market with highest positive EV at inference time.
"""
import json, sqlite3, numpy as np, xgboost as xgb, warnings, os, sys, argparse
warnings.filterwarnings('ignore')

UTILS_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(UTILS_DIR)

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

parser = argparse.ArgumentParser(description="High Chance Pick XGBoost Engine")
parser.add_argument('--db', default='', help='Path to sportybet_archive.db')
parser.add_argument('--out', default=UTILS_DIR, help='Output directory (utils/)')
args, _ = parser.parse_known_args()

DB_PATH           = find_valid_db(args.db, APP_DIR)
UTILS_DIR         = os.path.abspath(args.out) if args.out else UTILS_DIR
OUT_OVER25_MODEL  = os.path.join(UTILS_DIR, 'high_chance_over25_model.json')
OUT_GG_MODEL      = os.path.join(UTILS_DIR, 'high_chance_gg_model.json')
OUT_THRESH        = os.path.join(UTILS_DIR, 'high_chance_thresholds.json')
OUT_REPORT        = os.path.join(UTILS_DIR, 'high_chance_report.json')

# ── 1. Load data ──────────────────────────────────────────────────────────────
print(f"Loading historical_market_predictions from: {DB_PATH}")
conn = sqlite3.connect(DB_PATH)
rows = conn.execute("""
    SELECT id, home_team, away_team, predicted_probs, actual_score
    FROM historical_market_predictions
    WHERE actual_score IS NOT NULL AND actual_score LIKE '%:%'
      AND predicted_probs IS NOT NULL
    ORDER BY id ASC
""").fetchall()
conn.close()
print(f"Rows: {len(rows)}")

def parse_score(s):
    try: h,a=s.split(':'); return int(h),int(a)
    except: return None,None

def n(p, k): return (p.get(k) or 0) / 100

def build_sample(row):
    rid, home, away, probs_json, actual_score = row
    try: p = json.loads(probs_json)
    except: return None
    fH, fA = parse_score(actual_score)
    if fH is None: return None

    over25_label = 1 if (fH + fA) > 2 else 0
    gg_label     = 1 if (fH > 0 and fA > 0) else 0

    hw=n(p,'homeWinProb'); dr=n(p,'drawProb'); aw=n(p,'awayWinProb')
    o15=n(p,'over15Prob'); o25=n(p,'over25Prob'); o35=n(p,'over35Prob')
    o45=n(p,'over45Prob'); gg=n(p,'ggProb')
    hto25=n(p,'htOver25Prob'); hto35=n(p,'htOver35Prob')

    # Features carefully chosen to predict high-scoring / both-teams-score matches
    fv = [
        hw, dr, aw,                           # 1X2 market probs
        o15, o25, o35, o45,                   # goals market probs
        gg,                                    # BTTS prob
        hto25, hto35,                         # HT goals probs
        o25 - (1 - o25),                      # over25 margin
        gg - (1 - gg),                        # gg margin
        abs(hw - aw),                         # competitive balance (closer = more goals)
        max(hw, aw),                          # dominant team strength
        1 - dr,                               # non-draw probability (more goals = less draw)
        o25 * gg,                             # joint over25 + gg signal
        n(p,'htScoring1stProb'), n(p,'htScoring2ndProb'), n(p,'htScoringEqualProb'),
    ]
    return {
        'id': rid, 'features': fv,
        'over25_label': over25_label,
        'gg_label': gg_label,
        'over25_prob': o25,
        'gg_prob': gg,
    }

print("Building features...")
all_samples = [build_sample(r) for r in rows]
all_samples = [s for s in all_samples if s is not None]
print(f"Samples: {len(all_samples)}")
print(f"Over 2.5 rate: {sum(s['over25_label'] for s in all_samples)/len(all_samples)*100:.1f}%")
print(f"GG rate:       {sum(s['gg_label'] for s in all_samples)/len(all_samples)*100:.1f}%")

X_all = np.array([s['features'] for s in all_samples], dtype=np.float32)

# ── 2. Walk-forward CV — Over 2.5 model ──────────────────────────────────────
N = len(all_samples); FOLDS=5; fs=N//FOLDS

def run_cv(all_samples, label_key, typical_odd, name):
    cv_results = []
    print(f"\nCV for {name}:")
    for fold in range(FOLDS):
        train_end = fs*(fold+1)
        train = all_samples[:train_end]
        test  = all_samples[train_end:train_end+fs] if fold<FOLDS-1 else all_samples[train_end:]
        if len(test)<20: continue

        X_tr=np.array([s['features'] for s in train],dtype=np.float32)
        y_tr=np.array([s[label_key] for s in train],dtype=np.float32)
        X_te=np.array([s['features'] for s in test],dtype=np.float32)

        m=xgb.XGBClassifier(n_estimators=250,max_depth=6,learning_rate=0.05,
            subsample=0.8,colsample_bytree=0.8,min_child_weight=8,
            eval_metric='logloss',verbosity=0,random_state=42)
        m.fit(X_tr,y_tr)
        proba=m.predict_proba(X_te)[:,1]

        best_roi,best_t,best_n=-999,0.45,0
        for t in np.arange(0.35,0.80,0.025):
            bets,profit=0,0.0
            for i,s in enumerate(test):
                if proba[i]<t: continue
                ev=proba[i]*typical_odd-1
                if ev<=0: continue
                bets+=1
                profit+=(typical_odd-1) if s[label_key]==1 else -1
            if bets>=5:
                roi=profit/bets*100
                if roi>best_roi: best_roi,best_t,best_n=roi,t,bets

        cv_results.append({'fold':fold+1,'test_n':len(test),'thresh':round(best_t,3),
                            'roi':round(best_roi,2),'n':best_n,'profitable':best_roi>0})
        print(f"  Fold {fold+1}: thresh={best_t:.2f}  ROI={best_roi:+.1f}%  n={best_n}  {'✅' if best_roi>0 else '❌'}")

    profitable=sum(1 for r in cv_results if r['profitable'])
    avg_roi=np.mean([r['roi'] for r in cv_results]) if cv_results else 0
    print(f"  → {profitable}/{len(cv_results)} profitable  avg ROI: {avg_roi:+.1f}%")
    return cv_results, profitable, avg_roi

# Typical Sportybet odds for Over 2.5 and GG (from market_odds_history)
TYPICAL_OVER25_ODD = 1.95
TYPICAL_GG_ODD     = 2.00

cv_over25, prof_over25, roi_over25 = run_cv(all_samples, 'over25_label', TYPICAL_OVER25_ODD, 'Over 2.5 Goals')
cv_gg,     prof_gg,     roi_gg     = run_cv(all_samples, 'gg_label',     TYPICAL_GG_ODD,     'BTTS (GG)')

# ── 3. Train final models ─────────────────────────────────────────────────────
print("\nTraining final Over 2.5 model...")
y_over25=np.array([s['over25_label'] for s in all_samples],dtype=np.float32)
m_over25=xgb.XGBClassifier(n_estimators=350,max_depth=6,learning_rate=0.05,
    subsample=0.8,colsample_bytree=0.8,min_child_weight=8,
    eval_metric='logloss',verbosity=0,random_state=42)
m_over25.fit(X_all,y_over25)
m_over25.save_model(OUT_OVER25_MODEL)
print(f"  Over 2.5 model → {OUT_OVER25_MODEL}")

print("Training final GG model...")
y_gg=np.array([s['gg_label'] for s in all_samples],dtype=np.float32)
m_gg=xgb.XGBClassifier(n_estimators=350,max_depth=6,learning_rate=0.05,
    subsample=0.8,colsample_bytree=0.8,min_child_weight=8,
    eval_metric='logloss',verbosity=0,random_state=42)
m_gg.fit(X_all,y_gg)
m_gg.save_model(OUT_GG_MODEL)
print(f"  GG model → {OUT_GG_MODEL}")

# ── 4. Thresholds from holdout (last 20%) ─────────────────────────────────────
hstart=int(N*0.80); holdout=all_samples[hstart:]
X_ho=np.array([s['features'] for s in holdout],dtype=np.float32)
p_over25_ho=m_over25.predict_proba(X_ho)[:,1]
p_gg_ho    =m_gg.predict_proba(X_ho)[:,1]

def best_threshold(proba, holdout, label_key, typical_odd):
    best_roi,best_t,best_n=-999,0.45,0
    for t in np.arange(0.35,0.80,0.025):
        bets,profit=0,0.0
        for i,s in enumerate(holdout):
            if proba[i]<t: continue
            ev=proba[i]*typical_odd-1
            if ev<=0: continue
            bets+=1
            profit+=(typical_odd-1) if s[label_key]==1 else -1
        if bets>=10:
            roi=profit/bets*100
            if roi>best_roi: best_roi,best_t,best_n=roi,t,bets
    return best_t, best_roi, best_n

t_o25,roi_o25,n_o25 = best_threshold(p_over25_ho, holdout, 'over25_label', TYPICAL_OVER25_ODD)
t_gg, roi_gg2,n_gg  = best_threshold(p_gg_ho,     holdout, 'gg_label',     TYPICAL_GG_ODD)

print(f"\nHoldout Over 2.5: thresh={t_o25:.2f}  ROI={roi_o25:+.1f}%  n={n_o25}")
print(f"Holdout GG:       thresh={t_gg:.2f}  ROI={roi_gg2:+.1f}%  n={n_gg}")

# Use median of CV thresholds (robust)
cv_t_o25 = float(np.median([r['thresh'] for r in cv_over25 if r['profitable']] or [t_o25]))
cv_t_gg  = float(np.median([r['thresh'] for r in cv_gg     if r['profitable']] or [t_gg]))

thresholds = {
    'over25': {'min_prob': round(cv_t_o25,3), 'typical_odd': TYPICAL_OVER25_ODD,
               'holdout_roi': round(roi_o25,2), 'holdout_n': n_o25},
    'gg':     {'min_prob': round(cv_t_gg,3),  'typical_odd': TYPICAL_GG_ODD,
               'holdout_roi': round(roi_gg2,2), 'holdout_n': n_gg},
}
json.dump(thresholds, open(OUT_THRESH,'w'), indent=2)
print(f"Thresholds → {OUT_THRESH}")

def json_serial(obj):
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        return float(obj)
    return str(obj)

report = {
    'engine': 'high_chance_xgboost',
    'trained_on': int(len(all_samples)),
    'avg_oos_roi': round(float((roi_over25 + roi_gg) / 2.0), 2),
    'profitable_folds': int(min(prof_over25, prof_gg)),
    'over25': {'cv_folds': cv_over25, 'profitable_folds': int(prof_over25), 'avg_oos_roi': round(float(roi_over25),2)},
    'gg':     {'cv_folds': cv_gg,     'profitable_folds': int(prof_gg),     'avg_oos_roi': round(float(roi_gg),2)},
    'ready_for_deployment': bool((prof_over25>=3 and roi_over25>0) or (prof_gg>=3 and roi_gg>0))
}
with open(OUT_REPORT, 'w') as f:
    json.dump(report, f, indent=2, default=json_serial)

print(f"\n{'='*55}")
print(f"HIGH CHANCE ENGINE  ready={report['ready_for_deployment']}")
print(f"Over 2.5: {prof_over25}/{FOLDS} folds  avg ROI: {roi_over25:+.1f}%")
print(f"GG:       {prof_gg}/{FOLDS} folds  avg ROI: {roi_gg:+.1f}%")
print(f"{'='*55}")
