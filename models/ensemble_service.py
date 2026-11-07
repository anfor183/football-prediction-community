#!/usr/bin/env python3
"""
ensemble_service.py — Python ML Ensemble Service (Module 6)

Communicates with Node.js via newline-delimited JSON on stdin/stdout.
Trains 6 ML models on historical match data and returns agreement scores.

Supported actions:
  - predict: predict outcome + agreement for a matchup
  - optimize_ev_thresholds: walk-forward backtest to find optimal EV thresholds
  - shutdown: graceful exit

Dependencies (installed in venv):
  lightgbm, xgboost, catboost, scikit-learn, pandas, numpy
"""

import sys
import json
import os
import warnings
warnings.filterwarnings('ignore')

import numpy as np

# Lazy imports — only load heavy libs when actually needed
_SKLEARN_AVAILABLE = False
_LGBM_AVAILABLE = False
_XGB_AVAILABLE = False
_CATBOOST_AVAILABLE = False

try:
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler
    _SKLEARN_AVAILABLE = True
except ImportError:
    pass

try:
    import lightgbm as lgb
    _LGBM_AVAILABLE = True
except ImportError:
    pass

try:
    import xgboost as xgb
    _XGB_AVAILABLE = True
except ImportError:
    pass

try:
    from catboost import CatBoostClassifier
    _CATBOOST_AVAILABLE = True
except ImportError:
    pass

def log(msg):
    print(f"[ensemble_service] {msg}", file=sys.stderr, flush=True)


def build_features(matches, home_team, away_team, window=50):
    """
    Build feature vector for a home_team vs away_team matchup
    from historical match data.

    Features:
      - home_win_rate (last window)
      - away_win_rate (last window)
      - home_goals_scored_avg
      - away_goals_scored_avg
      - home_goals_conceded_avg
      - away_goals_conceded_avg
      - h2h_home_win_rate (head to head)
      - home_form (last 5 results: 1=win, 0.5=draw, 0=loss)
      - away_form (last 5 results)
      - home_goals_std
      - away_goals_std
    """
    # Filter relevant matches
    home_matches = [m for m in matches if m['h'] == home_team or m['a'] == home_team][-window:]
    away_matches = [m for m in matches if m['h'] == away_team or m['a'] == away_team][-window:]
    h2h = [m for m in matches if 
           (m['h'] == home_team and m['a'] == away_team) or
           (m['h'] == away_team and m['a'] == home_team)][-10:]

    def team_stats(team_matches, team):
        if not team_matches:
            return 0.33, 1.2, 1.0, 0.5
        wins = draws = 0
        gf_list = []
        ga_list = []
        for m in team_matches:
            if m['h'] == team:
                gf, ga = m['hs'], m['as']
            else:
                gf, ga = m['as'], m['hs']
            gf_list.append(gf)
            ga_list.append(ga)
            if gf > ga: wins += 1
            elif gf == ga: draws += 1
        wr = (wins + 0.5 * draws) / len(team_matches)
        gf_avg = np.mean(gf_list) if gf_list else 1.2
        ga_avg = np.mean(ga_list) if ga_list else 1.0
        gf_std = np.std(gf_list) if len(gf_list) > 1 else 0.5
        return wr, gf_avg, ga_avg, gf_std

    # Form (last 5)
    def form(team_matches, team, n=5):
        recent = team_matches[-n:]
        if not recent:
            return 0.5
        pts = []
        for m in recent:
            if m['h'] == team:
                gf, ga = m['hs'], m['as']
            else:
                gf, ga = m['as'], m['hs']
            pts.append(1.0 if gf > ga else (0.5 if gf == ga else 0.0))
        return np.mean(pts)

    home_wr, home_gf, home_ga, home_gf_std = team_stats(home_matches, home_team)
    away_wr, away_gf, away_ga, away_gf_std = team_stats(away_matches, away_team)
    home_form = form(home_matches, home_team)
    away_form = form(away_matches, away_team)

    # H2H win rate
    if h2h:
        h2h_hw = sum(1 for m in h2h if (m['h'] == home_team and m['hs'] > m['as']) or (m['a'] == home_team and m['as'] > m['hs']))
        h2h_wr = h2h_hw / len(h2h)
    else:
        h2h_wr = 0.5

    return [
        home_wr, away_wr,
        home_gf, away_gf,
        home_ga, away_ga,
        h2h_wr,
        home_form, away_form,
        home_gf_std, away_gf_std
    ]


def build_training_data(matches, max_samples=300):
    """
    Build X, y training arrays from historical match data.
    y: 0=home win, 1=draw, 2=away win
    """
    X, y = [], []
    n = len(matches)
    start_i = max(30, n - max_samples)

    for i in range(start_i, n):
        m = matches[i]
        training_slice = matches[max(0, i - 60):i]  # last 60 matches for team stats

        try:
            features = build_features(training_slice, m['h'], m['a'])
        except Exception:
            continue

        hs, as_ = m['hs'], m['as']
        if hs is None or as_ is None:
            continue
        if hs > as_:
            outcome = 0  # home
        elif hs == as_:
            outcome = 1  # draw
        else:
            outcome = 2  # away

        X.append(features)
        y.append(outcome)

    return np.array(X, dtype=np.float32), np.array(y, dtype=np.int32)


# Cache trained models to avoid retraining on every request
_model_cache = {}
_cache_key = None

def train_models(matches):
    global _model_cache, _cache_key

    # Cache key = number of training matches (retrains if data grows significantly)
    ck = len(matches) // 50  # retrain every 50 new matches
    if ck == _cache_key and _model_cache:
        return _model_cache

    log(f"Training models on {len(matches)} matches...")
    X, y = build_training_data(matches)

    if len(X) < 20:
        log("Not enough training data")
        return {}

    models = {}
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    if _SKLEARN_AVAILABLE:
        try:
            lr = LogisticRegression(max_iter=500, random_state=42, C=1.0)
            lr.fit(X_scaled, y)
            models['logreg'] = ('sklearn', lr, scaler)
        except Exception as e:
            log(f"LogReg failed: {e}")

        try:
            rf = RandomForestClassifier(n_estimators=100, max_depth=5, random_state=42, n_jobs=-1)
            rf.fit(X, y)
            models['rf'] = ('sklearn_raw', rf, None)
        except Exception as e:
            log(f"RF failed: {e}")

        try:
            mlp = MLPClassifier(hidden_layer_sizes=(64, 32), max_iter=300, random_state=42)
            mlp.fit(X_scaled, y)
            models['mlp'] = ('sklearn', mlp, scaler)
        except Exception as e:
            log(f"MLP failed: {e}")

    if _LGBM_AVAILABLE:
        try:
            lgbm = lgb.LGBMClassifier(
                n_estimators=200, learning_rate=0.05, max_depth=4,
                random_state=42, n_jobs=-1, verbose=-1
            )
            lgbm.fit(X, y)
            models['lgbm'] = ('raw', lgbm, None)
        except Exception as e:
            log(f"LightGBM failed: {e}")

    if _XGB_AVAILABLE:
        try:
            xgboost = xgb.XGBClassifier(
                n_estimators=200, learning_rate=0.05, max_depth=4,
                random_state=42, n_jobs=-1, verbosity=0, eval_metric='mlogloss'
            )
            xgboost.fit(X, y)
            models['xgb'] = ('raw', xgboost, None)
        except Exception as e:
            log(f"XGBoost failed: {e}")

    if _CATBOOST_AVAILABLE:
        try:
            cb = CatBoostClassifier(
                iterations=200, learning_rate=0.05, depth=4,
                random_state=42, verbose=0
            )
            cb.fit(X, y)
            models['catboost'] = ('raw', cb, None)
        except Exception as e:
            log(f"CatBoost failed: {e}")

    _model_cache = models
    _cache_key = ck
    log(f"Trained {len(models)} models: {list(models.keys())}")
    return models


LABEL_MAP = {0: 'home', 1: 'draw', 2: 'away'}
REVERSE_MAP = {'home': 0, 'draw': 1, 'away': 2}


def predict_matchup(matches, home_team, away_team, predicted_outcome):
    """
    Run all trained models and return agreement scores.
    """
    models = train_models(matches)

    if not models:
        # Fallback: no models available
        return {
            'agreementScore': 0.5,
            'modelVotes': {'home': 0.33, 'draw': 0.34, 'away': 0.33},
            'consensusOutcome': predicted_outcome,
            'modelDetails': {},
            'available': False
        }

    features = build_features(matches, home_team, away_team)
    X = np.array([features], dtype=np.float32)

    votes = {0: 0, 1: 0, 2: 0}  # home, draw, away
    model_details = {}
    target_label = REVERSE_MAP.get(predicted_outcome, 0)

    for name, (mode, model, scaler) in models.items():
        try:
            if mode == 'sklearn':
                X_in = scaler.transform(X) if scaler else X
            else:
                X_in = X

            probs = model.predict_proba(X_in)[0]
            pred_label = int(np.argmax(probs))
            votes[pred_label] += 1

            model_details[name] = {
                'prediction': LABEL_MAP[pred_label],
                'confidence': round(float(probs[pred_label]), 3),
                'probs': {LABEL_MAP[i]: round(float(probs[i]), 3) for i in range(3)}
            }
        except Exception as e:
            model_details[name] = {'error': str(e)}

    total_models = sum(votes.values())
    if total_models == 0:
        return {'agreementScore': 0.5, 'modelVotes': {'home': 0.33, 'draw': 0.34, 'away': 0.33},
                'consensusOutcome': predicted_outcome, 'modelDetails': model_details, 'available': False}

    agreement_score = votes.get(target_label, 0) / total_models
    consensus_label = max(votes, key=votes.get)

    return {
        'agreementScore': round(agreement_score, 3),
        'modelVotes': {
            'home': round(votes[0] / total_models, 3),
            'draw': round(votes[1] / total_models, 3),
            'away': round(votes[2] / total_models, 3)
        },
        'consensusOutcome': LABEL_MAP[consensus_label],
        'modelDetails': model_details,
        'available': True
    }


def optimize_ev_thresholds(settled_picks):
    """
    Walk-forward backtest to find optimal EV thresholds per pick type.
    Tests a grid of threshold combinations and returns the one maximizing ROI.
    """
    if not settled_picks or len(settled_picks) < 30:
        return {'safest': 0.02, 'highValue': 0.05, 'highRisk': 0.08, 'note': 'insufficient_data'}

    # Filter out picks with no EV score
    picks_with_ev = [p for p in settled_picks if p.get('ev_score') is not None]
    if len(picks_with_ev) < 15:
        return {'safest': 0.02, 'highValue': 0.05, 'highRisk': 0.08, 'note': 'insufficient_ev_data'}

    best = {'safest': 0.02, 'highValue': 0.05, 'highRisk': 0.08, 'roi': -9999}

    for safest_t in [0.0, 0.01, 0.02, 0.03, 0.05]:
        for hv_t in [0.03, 0.05, 0.07, 0.08, 0.10]:
            for hr_t in [0.05, 0.07, 0.08, 0.10, 0.12]:
                total_profit = 0
                total_bets = 0
                for p in picks_with_ev:
                    ev = p.get('ev_score', 0)
                    pt = p.get('pick_type', '')
                    odd = p.get('implied_odd', 2.0)
                    won = p.get('status') == 'won'

                    threshold = safest_t if pt == 'safest' else hv_t if pt == 'high_value' else hr_t

                    if ev >= threshold:
                        total_bets += 1
                        total_profit += (odd - 1) if won else -1

                if total_bets > 0:
                    roi = total_profit / total_bets
                    if roi > best['roi']:
                        best = {'safest': safest_t, 'highValue': hv_t, 'highRisk': hr_t,
                                'roi': round(roi, 4), 'bets': total_bets}

    return best


def main():
    log(f"Ensemble service starting. Available: sklearn={_SKLEARN_AVAILABLE}, lgbm={_LGBM_AVAILABLE}, xgb={_XGB_AVAILABLE}, catboost={_CATBOOST_AVAILABLE}")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({'requestId': 0, 'error': f'JSON parse error: {e}'}), flush=True)
            continue

        request_id = msg.get('requestId', 0)
        action = msg.get('action', '')

        try:
            if action == 'predict':
                training_matches = msg.get('trainingMatches', [])
                home_team = msg.get('homeTeam', '')
                away_team = msg.get('awayTeam', '')
                predicted_outcome = msg.get('predictedOutcome', 'home')

                result = predict_matchup(training_matches, home_team, away_team, predicted_outcome)
                result['requestId'] = request_id
                print(json.dumps(result), flush=True)

            elif action == 'optimize_ev_thresholds':
                settled_picks = msg.get('settledPicks', [])
                result = optimize_ev_thresholds(settled_picks)
                result['requestId'] = request_id
                print(json.dumps(result), flush=True)

            elif action == 'shutdown':
                log("Shutting down gracefully.")
                print(json.dumps({'requestId': request_id, 'status': 'shutdown'}), flush=True)
                sys.exit(0)

            else:
                print(json.dumps({'requestId': request_id, 'error': f'Unknown action: {action}'}), flush=True)

        except Exception as e:
            log(f"Error processing action '{action}': {e}")
            import traceback
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({'requestId': request_id, 'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
