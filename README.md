# ⚽ Event-Driven Football Simulation & Statistical Prediction Engine

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Electron 29](https://img.shields.io/badge/Electron-29-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Better-SQLite3](https://img.shields.io/badge/SQLite-WAL%20Mode-003B57?style=for-the-badge&logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

An enterprise-grade quantitative probability modeling platform, backtesting engine, and real-time desktop dashboard designed for event-driven sports simulation and predictive analytics.

---

## 📌 Architectural Overview

The engine processes real-time match events, historical scorelines, and market odds to generate probabilistic forecasts across major markets: 1X2 Match Outcomes, Over/Under Goal Totals (1.5, 2.5, 3.5), Both Teams to Score (BTTS / GG), and Half-Time/Full-Time (HT/FT) transitions.

```
                          ┌─────────────────────────────────────┐
                          │   Live Ingestion Bridge (API / WS)  │
                          └──────────────────┬──────────────────┘
                                             │
                                             ▼
                          ┌─────────────────────────────────────┐
                          │   Time-Series SQLite Storage (WAL)  │
                          └──────────────────┬──────────────────┘
                                             │
                      ┌──────────────────────┴──────────────────────┐
                      ▼                                             ▼
        ┌───────────────────────────┐                 ┌───────────────────────────┐
        │  Statistical Analytics    │                 │   Machine Learning Core   │
        ├───────────────────────────┤                 ├───────────────────────────┤
        │ • Poisson Distributions   │                 │ • Multi-Model Ensembles   │
        │ • Exponential Time Decay  │                 │ • Feature Engineering     │
        │ • HT/FT Markovian Matrix  │                 │ • Automated Calibration   │
        │ • EV Odds Discrepancy     │                 │ • Dynamic Risk Sizing     │
        └─────────────┬─────────────┘                 └─────────────┬─────────────┘
                      │                                             │
                      └──────────────────────┬──────────────────────┘
                                             │
                                             ▼
                          ┌─────────────────────────────────────┐
                          │   Desktop Dashboard (Electron+React)│
                          │   • Real-Time Match Timeline        │
                          │   • Equity Curve & Bankroll Sim     │
                          │   • Market Drift & Value Flagging   │
                          └─────────────────────────────────────┘
```

> 🔒 **Ingestion Architecture Note:**  
> The live headless Chromium browser automation crawler, residential proxy tunneling, and anti-fingerprint identity layers are maintained in a proprietary decoupled private module. The crawler transmits normalized event blocks to this engine via the `api/data_ingestion_adapter.js` bridge.

---

## 🔬 Mathematical & Statistical Methodology

### 1. Independent & Bivariate Poisson Goal Distribution
Goal probabilities for Home Team ($X$) and Away Team ($Y$) are modeled using Poisson probability mass functions parameterized by dynamic attack ($\alpha$) and defense ($\beta$) coefficients:

$$P(X = x) = \frac{\lambda^x e^{-\lambda}}{x!}, \quad P(Y = y) = \frac{\mu^y e^{-\mu}}{y!}$$

Joint match score probabilities $P(X=x, Y=y)$ project exact-score matrices, which aggregate into continuous distributions for Over/Under 1.5, 2.5, and 3.5 goals.

### 2. Exponential Time-Decay Weighting
To balance long-term sample size with immediate team form momentum, historical matches are weighted using an exponential decay kernel:

$$w_i = e^{-\lambda \cdot \Delta t_i}$$

where $\Delta t_i$ represents elapsed rounds/days, ensuring recent performance shifts dynamically influence current match attack/defense ratings.

### 3. Expected Value ($EV$) & Consensus Margin Extraction
The engine calculates expected market value by comparing model-implied probabilities against bookmaker consensus odds:

$$EV = (P_{\text{model}} \times \text{Odds}_{\text{market}}) - 1$$

Picks are executed only when $EV > \text{Threshold}$ and the confidence index satisfies strict risk parameters.

---

## 🚀 Key Modules

| Directory | Purpose | Core Technologies |
| :--- | :--- | :--- |
| `analytics/` | Poisson modeling, time-decay kernels, HT/FT calibration, pattern analyzers | JavaScript (ES6+), Mathematical Statistics |
| `models/` | ML feature engineering, pre-trained ensemble weights, automated model retraining daemons | Python 3.12, scikit-learn, JSON weights |
| `dashboard/` | Full-stack desktop application for operator monitoring and simulation | Electron 29, React 18, Vite, TailwindCSS |
| `database/` | High-concurrency time-series database operations (WAL mode), pruning, and integrity auditing | Better-SQLite3, SQLite WAL Mode |
| `backtest/` | Simulation engine evaluating historical equity curves, drawdown ratios, and win-rates | Node.js, Custom Backtest Harness |
| `api/` | WebSocket bridge and REST endpoints for external event streaming | Express, WS, EventEmitter |

---

## 💻 Quick Start & Installation

### 1. Prerequisites
- **Node.js** (v18.0.0 or higher)
- **Python** (v3.10+ with `scipy`, `numpy`, `scikit-learn`)

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/anfor183/football-simulation-prediction-engine.git
cd football-simulation-prediction-engine

# Install root dependencies
npm install

# Install dashboard dependencies
cd dashboard
npm install
cd ..
```

### 3. Running the Engine
```bash
# Launch the Electron + React Desktop Dashboard
npm run dashboard:dev

# Launch the Remote API Server & Ingestion Bridge
npm run api

# Execute Backtesting Simulation across Historical Matches
npm run backtest
```

---

## 🛡️ License

This project is licensed under the [MIT License](LICENSE).

---

## 👨‍💻 Author & Contact

**anfor183**  
*Software Engineer • Quantitative Systems & Automation Developer*  
- **Email**: [163532559+anfor183@users.noreply.github.com](mailto:163532559+anfor183@users.noreply.github.com)  
- **GitHub**: [@anfor183](https://github.com/anfor183)  
- **Location**: Abuja, Nigeria (Open to Remote & Relocation)
