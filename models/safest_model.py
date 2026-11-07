#!/usr/bin/env python3
"""
Safest Pick XGBoost Engine — Training Script
Trains a binary classifier: will the model's top-confidence 1X2 pick win?
Training data: historical_market_predictions (27k rows) with settled outcomes.
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

parser = argparse.ArgumentParser(description="Safest Pick XGBoost Engine")
parser.add_argument('--db', default='', help='Path to sportybet_archive.db')
parser.add_argument('--out', default=UTILS_DIR, help='Output directory (utils/)')
args, _ = parser.parse_known_args()

DB_PATH    = find_valid_db(args.db, APP_DIR)
UTILS_DIR  = os.path.abspath(args.out) if args.out else UTILS_DIR
OUT_MODEL  = os.path.join(UTILS_DIR, 'safest_model.json')
OUT_THRESH = os.path.join(UTILS_DIR, 'safest_thresholds.json')
OUT_REPORT = os.path.join(UTILS_DIR, 'safest_report.json')

# ── 1. Load ───────────────────────────────────────────────────────────────────
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

def build_samples(row):
    rid, home, away, probs_json, actual_score = row
    try: p = json.loads(probs_json)
    except: return []
    fH, fA = parse_score(actual_score)
    if fH is None: return []
    actual = 'home' if fH>fA else ('away' if fH<fA else 'draw')
    hw = (p.get('homeWinProb') or 0)/100
    dr = (p.get('drawProb') or 0)/100
    aw = (p.get('awayWinProb') or 0)/100
    o15=(p.get('over15Prob') or 0)/100; o25=(p.get('over25Prob') or 0)/100
    o35=(p.get('over35Prob') or 0)/100; gg=(p.get('ggProb') or 0)/100

    samples = []
    for market, mp, rk in [('home',hw,'home'),('away',aw,'away'),('draw',dr,'draw')]:
        if mp < 0.50: continue  # only high-confidence picks
        label = 1 if actual == rk else 0
        fv = [hw,dr,aw, o15,o25,o35,gg, mp, abs(hw-aw),
              max(hw,aw,dr), 1.0-mp,  # uncertainty
              1 if market=='home' else 0,
              1 if market=='away' else 0,
              1 if market=='draw' else 0,
              1 if hw>0.5 else 0, 1 if aw>0.5 else 0]
        samples.append({'id':rid,'market':market,'model_p':mp,'label':label,'features':fv})
    return samples

print("Building features...")
all_samples = []
for r in rows:
    all_samples.extend(build_samples(r))
print(f"Samples: {len(all_samples)}  WinRate: {sum(s['label'] for s in all_samples)/len(all_samples)*100:.1f}%")

# ── 2. Walk-forward CV ────────────────────────────────────────────────────────
N = len(all_samples); FOLDS=5; fold_size=N//FOLDS
TYPICAL = {'home':1.55,'away':1.55,'draw':3.20}
cv_results = []

print(f"\nWalk-forward CV ({FOLDS} folds)...")
for fold in range(FOLDS):
    train_end = fold_size*(fold+1)
    train = all_samples[:train_end]
    test  = all_samples[train_end:train_end+fold_size] if fold<FOLDS-1 else all_samples[train_end:]
    if len(test)<20: continue

    X_tr=np.array([s['features'] for s in train],dtype=np.float32)
    y_tr=np.array([s['label'] for s in train],dtype=np.float32)
    X_te=np.array([s['features'] for s in test],dtype=np.float32)

    m = xgb.XGBClassifier(n_estimators=200,max_depth=5,learning_rate=0.05,
        subsample=0.8,colsample_bytree=0.8,min_child_weight=10,
        scale_pos_weight=sum(y_tr==0)/max(sum(y_tr==1),1),
        eval_metric='logloss',verbosity=0,random_state=42)
    m.fit(X_tr,y_tr)
    proba=m.predict_proba(X_te)[:,1]

    best_roi,best_t,best_n=-999,0.70,0
    for t in np.arange(0.55,0.96,0.02):
        bets,profit=0,0.0
        for i,s in enumerate(test):
            if proba[i]<t: continue
            odd=TYPICAL.get(s['market'],1.55); bets+=1
            profit+=(odd-1) if s['label']==1 else -1
        if bets>=5:
            roi=profit/bets*100
            if roi>best_roi: best_roi,best_t,best_n=roi,t,bets

    cv_results.append({'fold':fold+1,'test_n':len(test),'thresh':round(best_t,3),
                        'roi':round(best_roi,2),'n':best_n,'profitable':best_roi>0})
    print(f"  Fold {fold+1}: thresh={best_t:.2f}  ROI={best_roi:+.1f}%  n={best_n}  {'✅' if best_roi>0 else '❌'}")

profitable=sum(1 for r in cv_results if r['profitable'])
avg_roi=np.mean([r['roi'] for r in cv_results])
print(f"\nResult: {profitable}/{len(cv_results)} profitable  avg OOS ROI: {avg_roi:+.1f}%")

# ── 3. Final model ────────────────────────────────────────────────────────────
print("\nTraining final model on ALL data...")
X_all=np.array([s['features'] for s in all_samples],dtype=np.float32)
y_all=np.array([s['label'] for s in all_samples],dtype=np.float32)
final=xgb.XGBClassifier(n_estimators=300,max_depth=5,learning_rate=0.05,
    subsample=0.8,colsample_bytree=0.8,min_child_weight=10,
    scale_pos_weight=sum(y_all==0)/max(sum(y_all==1),1),
    eval_metric='logloss',verbosity=0,random_state=42)
final.fit(X_all,y_all)
final.save_model(OUT_MODEL)
print(f"Model → {OUT_MODEL}")

# ── 4. Threshold from holdout (last 20%) ─────────────────────────────────────
hstart=int(N*0.80); holdout=all_samples[hstart:]
X_ho=np.array([s['features'] for s in holdout],dtype=np.float32)
p_ho=final.predict_proba(X_ho)[:,1]
best_roi,best_t,best_n=-999,0.70,0
for t in np.arange(0.55,0.96,0.02):
    bets,profit=0,0.0
    for i,s in enumerate(holdout):
        if p_ho[i]<t: continue
        odd=TYPICAL.get(s['market'],1.55); bets+=1
        profit+=(odd-1) if s['label']==1 else -1
    if bets>=10:
        roi=profit/bets*100
        if roi>best_roi: best_roi,best_t,best_n=roi,t,bets

print(f"Holdout threshold: {best_t:.2f}  ROI: {best_roi:+.1f}%  n={best_n}")

# Median of CV thresholds as a robust choice
cv_thresh=np.median([r['thresh'] for r in cv_results if r['profitable']])
final_thresh=min(float(cv_thresh),float(best_t)) if cv_results else float(best_t)

json.dump({'global_min_prob':round(final_thresh,3),'holdout_roi':round(best_roi,2),
           'holdout_n':best_n,'note':'XGBoost P(win) must exceed this for a Safest bet'},
    open(OUT_THRESH,'w'),indent=2)
print(f"Thresholds → {OUT_THRESH}")

def json_serial(obj):
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        return float(obj)
    return str(obj)

report={'engine':'safest_xgboost','trained_on':int(len(all_samples)),'folds':cv_results,
        'profitable_folds':int(profitable),'avg_oos_roi':round(float(avg_roi),2),
        'final_threshold':round(float(final_thresh),3),
        'ready_for_deployment':bool(profitable>=3 and avg_roi>0)}
with open(OUT_REPORT, 'w') as f:
    json.dump(report, f, indent=2, default=json_serial)

print(f"\n{'='*55}")
print(f"SAFEST ENGINE  ready={report['ready_for_deployment']}")
print(f"Profitable folds: {profitable}/{len(cv_results)}  avg ROI: {avg_roi:+.1f}%")
print(f"{'='*55}")
