"""
TrackShift — Multi-Circuit F1 Telemetry & Tyre Debt API.
Hybrid ML + Deep Learning Architecture with Cache-First Serving Layer.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse
from starlette.middleware.gzip import GZipMiddleware
import sqlite3
import pandas as pd
import os
import time
import logging

from api.cache import get_cache_service
from api.models import get_model_registry, BEHAVIORAL_FEATURES
from api.services import (
    CircuitsService,
    StintsService,
    TyreDebtService,
    CounterfactualService,
    SignaturesService,
    DegradationService,
    RaceIntelligenceService
)
from api.routers import (
    circuits_router,
    set_circuits_service,
    seasons_router,
    set_seasons_circuits_service,
    stints_router,
    set_stint_services,
    signatures_router,
    set_signatures_service,
    degradation_router,
    set_degradation_service,
    race_intelligence_router,
    set_race_intelligence_service,
    strategic_warfare_router,
    tyre_intelligence_router,
    admin_router,
    tdsm_router,
    tdsm_v1_router,
    physical_telemetry_router
)
from api.services.physical_telemetry_service import get_physical_telemetry_service

logger = logging.getLogger("trackshift.api")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'api', 'tyredebt.db')
DATA_DIR = os.path.join(BASE_DIR, 'data')
LEDGER_PARQUET = os.path.join(DATA_DIR, 'residual_ledger.parquet')
LAPS_PARQUET = os.path.join(DATA_DIR, 'laps.parquet')
GEOMETRY_PARQUET = os.path.join(DATA_DIR, 'circuit_geometry.parquet')
BOOTSTRAP_PARQUET = os.path.join(DATA_DIR, 'bootstrap_uncertainty.parquet')

PREDICTIONS_PARQUET = os.path.join(DATA_DIR, 'baseline_predictions.parquet')

# In-memory fast stores
app_data = {
    "active_models": {},          # stage -> model_version
    "coefficients": {},           # (model_version, feature_name, track_scope) -> coef
    "ledger": {},                 # stint_id -> list of dicts {lap_number, residual, cumulative_debt}
    "stint_feature_means": {},    # stint_id -> dict of feature means
    "stint_avg_loss_per_lap": {}, # stint_id -> float (used to convert debt to laps)
    "driver_signatures": {},      # driver_id -> dict of global feature means
    "stint_track_map": {},        # stint_id -> track_id
    "stint_lengths": {},          # stint_id -> int
    "circuit_geometry": {},       # circuit_id -> list of dicts (track points)
    "circuit_corners": {},        # circuit_id -> list of dicts (corners)
    "bootstrap_uncertainty": {},  # (stint_id, feature, delta_pct) -> dict of empirical bounds
    "laps_df": None,              # In-memory cached laps DataFrame
    "ledger_df": None,            # In-memory cached ledger DataFrame
    "predictions_df": None,       # In-memory cached baseline predictions DataFrame
    "geom_df": None               # In-memory cached geometry DataFrame
}


def validate_production_schemas():
    """Validates presence and schema of all required production datasets at startup."""
    required_files = [
        ("SQLite Database", DB_PATH),
        ("Laps Parquet", LAPS_PARQUET),
        ("Ledger Parquet", LEDGER_PARQUET),
        ("Geometry Parquet", GEOMETRY_PARQUET),
        ("Predictions Parquet", PREDICTIONS_PARQUET),
        ("Bootstrap Parquet", BOOTSTRAP_PARQUET),
    ]
    for name, path in required_files:
        if not os.path.exists(path):
            raise RuntimeError(f"CRITICAL STARTUP FAILURE: Required dataset '{name}' not found at '{path}'")

    # Validate essential columns
    laps_sample = pd.read_parquet(LAPS_PARQUET)
    req_laps_cols = ['stint_id', 'circuit_id', 'session_id', 'driver_id', 'lap_number', 'lap_time'] + BEHAVIORAL_FEATURES
    for c in req_laps_cols:
        if c not in laps_sample.columns:
            raise RuntimeError(f"CRITICAL SCHEMA FAILURE: laps.parquet missing column '{c}'")

    ledger_sample = pd.read_parquet(LEDGER_PARQUET)
    req_ledger_cols = ['stint_id', 'lap_number', 'residual', 'cumulative_debt']
    for c in req_ledger_cols:
        if c not in ledger_sample.columns:
            raise RuntimeError(f"CRITICAL SCHEMA FAILURE: residual_ledger.parquet missing column '{c}'")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Validate Production Schemas & Fail Fast if Corrupt
    validate_production_schemas()
    app.state.app_data = app_data

    # 2. Initialize Cache & Model Registry
    cache = get_cache_service()
    await cache.initialize()
    
    registry = get_model_registry()
    registry.load_registry()

    # 3. Load SQLite Models & Metadata
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT stage, model_version, held_out_metric FROM model_registry WHERE is_active = 1")
    rows = cursor.fetchall()
    for row in rows:
        app_data["active_models"][row['stage']] = row['model_version']
    
    if 1 not in app_data["active_models"]:
        app_data["active_models"][1] = registry.get_stage_version(1)
    if 3 not in app_data["active_models"]:
        app_data["active_models"][3] = registry.get_stage_version(3)
    
    stage3_version = app_data["active_models"][3]
    cursor.execute("SELECT feature_name, track_scope, coefficient FROM model_coefficients WHERE model_version = ?", (stage3_version,))
    for row in cursor.fetchall():
        app_data["coefficients"][(stage3_version, row['feature_name'], row['track_scope'])] = row['coefficient']
    
    cursor.execute("""
        SELECT s.stint_id, r.track_id, (s.end_lap - s.start_lap + 1) as stint_len
        FROM stints s
        JOIN sessions ses ON s.session_id = ses.session_id
        JOIN races r ON ses.race_id = r.race_id
    """)
    for row in cursor.fetchall():
        app_data["stint_track_map"][row['stint_id']] = row['track_id']
        app_data["stint_lengths"][row['stint_id']] = max(5, row['stint_len'] if row['stint_len'] else 20)
        
    cursor.execute("SELECT circuit_id, corner_number, corner_letter, x, y, angle, distance FROM circuit_corners ORDER BY circuit_id, corner_number")
    corners_rows = cursor.fetchall()
    for row in corners_rows:
        cid = row['circuit_id']
        if cid not in app_data["circuit_corners"]:
            app_data["circuit_corners"][cid] = []
        app_data["circuit_corners"][cid].append({
            "corner_number": row['corner_number'],
            "corner_letter": row['corner_letter'],
            "x": row['x'],
            "y": row['y'],
            "angle": row['angle'],
            "distance": row['distance']
        })
        
    conn.close()
    
    # 4. Load Circuit Geometry Parquet
    if os.path.exists(GEOMETRY_PARQUET):
        geom_df = pd.read_parquet(GEOMETRY_PARQUET)
        app_data["geom_df"] = geom_df
        for cid, group in geom_df.groupby('circuit_id'):
            pts = group[['x_rot', 'y_rot', 'X', 'Y', 'Distance', 'Speed', 'Throttle', 'Brake']].rename(
                columns={'X': 'x', 'Y': 'y', 'Distance': 'distance', 'Speed': 'speed', 'Throttle': 'throttle', 'Brake': 'brake'}
            ).to_dict(orient='records')
            app_data["circuit_geometry"][cid] = pts
            
    # 5. Load Ledger & Laps Parquets and Build In-Memory Indexed Structures
    if os.path.exists(LEDGER_PARQUET):
        ledger_df = pd.read_parquet(LEDGER_PARQUET)
        app_data["ledger_df"] = ledger_df
        for stint_id, group in ledger_df.groupby('stint_id'):
            series = group[['lap_number', 'residual', 'cumulative_debt']].to_dict(orient='records')
            app_data["ledger"][stint_id] = series

    if os.path.exists(PREDICTIONS_PARQUET):
        pred_df = pd.read_parquet(PREDICTIONS_PARQUET)
        app_data["predictions_df"] = pred_df
            
    if os.path.exists(LAPS_PARQUET) and os.path.exists(LEDGER_PARQUET):
        laps_df = pd.read_parquet(LAPS_PARQUET)
        app_data["laps_df"] = laps_df
        
        means_df = laps_df.groupby('stint_id')[BEHAVIORAL_FEATURES].mean()
        app_data["stint_feature_means"] = means_df.to_dict(orient='index')
        
        if 'predicted_lap_time_loss' in ledger_df.columns:
            def calc_deg_rate(group):
                if len(group) < 2:
                    return 0.1
                group = group.sort_values('lap_number')
                first = group.iloc[0]
                last = group.iloc[-1]
                dn = last['lap_number'] - first['lap_number']
                if dn == 0:
                    return 0.1
                rate = (last['predicted_lap_time_loss'] - first['predicted_lap_time_loss']) / dn
                return float(rate) if rate != 0 else 0.1
            
            rates = ledger_df.groupby('stint_id').apply(calc_deg_rate, include_groups=False)
            app_data["stint_avg_loss_per_lap"] = rates.to_dict()

        with sqlite3.connect(DB_PATH) as conn2:
            conn2.row_factory = sqlite3.Row
            cursor2 = conn2.cursor()
            cursor2.execute("SELECT stint_id, driver_id FROM stints")
            stints_map = {row['stint_id']: row['driver_id'] for row in cursor2.fetchall()}
        
        means_df_with_driver = means_df.copy()
        means_df_with_driver['driver_id'] = means_df_with_driver.index.map(stints_map)
        
        driver_signatures = means_df_with_driver.groupby('driver_id')[BEHAVIORAL_FEATURES].mean()
        app_data["driver_signatures"] = driver_signatures.to_dict(orient='index')

        # Fast in-memory session and stint maps for zero-allocation request routing
        app_data["laps_by_session"] = {str(sid): grp for sid, grp in laps_df.groupby('session_id')}
        app_data["laps_by_stint"] = {str(stid): grp for stid, grp in laps_df.groupby('stint_id')}
        app_data["ledger_by_stint"] = {str(stid): grp for stid, grp in ledger_df.groupby('stint_id')}

    # 6. Load Precomputed Bootstrap Uncertainty
    if os.path.exists(BOOTSTRAP_PARQUET):
        boot_df = pd.read_parquet(BOOTSTRAP_PARQUET)
        for row in boot_df.itertuples(index=False):
            key = (row.stint_id, row.feature, round(float(row.delta_pct), 1))
            app_data["bootstrap_uncertainty"][key] = {
                "recovered_p50": float(row.recovered_p50),
                "ci_lower": float(row.ci_lower),
                "ci_upper": float(row.ci_upper),
                "ci_margin": float(row.ci_margin),
                "is_saturated": bool(row.is_saturated)
            }

    # 7. Initialize Services and Inject into Routers
    circuits_svc = CircuitsService(DB_PATH, app_data)
    stints_svc = StintsService(DB_PATH, app_data)
    tyre_debt_svc = TyreDebtService(DB_PATH, app_data)
    counterfactual_svc = CounterfactualService(app_data)
    signatures_svc = SignaturesService(DB_PATH, app_data)
    degradation_svc = DegradationService(DB_PATH, app_data)
    race_intel_svc = RaceIntelligenceService(DB_PATH, app_data)

    set_circuits_service(circuits_svc)
    set_seasons_circuits_service(circuits_svc)
    set_stint_services(stints_svc, tyre_debt_svc, counterfactual_svc)
    set_signatures_service(signatures_svc)
    set_degradation_service(degradation_svc)
    set_race_intelligence_service(race_intel_svc)

    # 8. Pre-load Reports into app_data
    import json
    val_file = os.path.join(BASE_DIR, "reports", "post_race_validation_plus15.json")
    if os.path.exists(val_file):
        with open(val_file, "r") as f:
            app_data["precomputed_post_race_validation"] = json.load(f)

    pit_stab_file = os.path.join(BASE_DIR, "reports", "pit_window_stability.json")
    if os.path.exists(pit_stab_file):
        with open(pit_stab_file, "r") as f:
            app_data["precomputed_pit_window_stability"] = json.load(f)

    unc_file = os.path.join(BASE_DIR, "reports", "uncertainty_validation.json")
    if os.path.exists(unc_file):
        with open(unc_file, "r") as f:
            app_data["precomputed_uncertainty_validation"] = json.load(f)

    # 9. Warm DL Architecture & Model Inference Kernels
    try:
        if registry.behavioral_model:
            import torch
            dummy_tcn = torch.zeros((1, 5, 15), dtype=torch.float32)
            registry.behavioral_model.model.eval()
            with torch.no_grad():
                _ = registry.behavioral_model.model(dummy_tcn)
    except Exception as e:
        logger.warning(f"DL Model warming warning: {e}")

    yield

    await cache.close()


app = FastAPI(
    title="TrackShift — Hybrid ML/DL F1 Telemetry & Tyre Debt API",
    description="Modular service-based serving architecture with TCN behavioral embeddings and classical ML attribution",
    lifespan=lifespan,
    default_response_class=ORJSONResponse
)

cors_origins_env = os.environ.get("CORS_ORIGINS")
cors_origins = [o.strip() for o in cors_origins_env.split(",") if o.strip()] if cors_origins_env else [
    "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8000", "http://127.0.0.1:8000", "*"
]

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Attach Modular Routers
app.include_router(seasons_router)
app.include_router(circuits_router)
app.include_router(stints_router)
app.include_router(signatures_router)
app.include_router(degradation_router)
app.include_router(race_intelligence_router)
app.include_router(strategic_warfare_router)
app.include_router(tyre_intelligence_router)
app.include_router(admin_router)
app.include_router(tdsm_router)
app.include_router(tdsm_v1_router)
app.include_router(physical_telemetry_router)




@app.get("/ping")
@app.post("/ping")
async def ping():
    return {"ok": True}


@app.get("/health")
async def health_check():
    cache = get_cache_service()
    registry = get_model_registry()
    return {
        "status": "ok",
        "cache": {
            "tier": "redis" if cache.is_redis_active else "memory_fallback",
            "redis_connected": cache.is_redis_active,
            "hit_rate": cache.get_stats()["cache_hit_rate"]
        },
        "models_loaded": {
            "stage_1": app_data["active_models"].get(1, registry.get_stage_version(1)),
            "stage_3": app_data["active_models"].get(3, registry.get_stage_version(3)),
            "dl_architecture": "tcn" if registry.behavioral_model else "none"
        },
        "circuits_available": len(app_data["circuit_geometry"]),
        "stints_available": len(app_data["ledger"]),
        "drivers": list(app_data["driver_signatures"].keys()),
        "bootstrap_uncertainty_loaded": len(app_data["bootstrap_uncertainty"]) > 0
    }


@app.get("/sessions/{session_id}/drivers")
@app.get("/api/sessions/{session_id}/drivers")
async def get_session_drivers_global(session_id: str):
    parts = session_id.split('_')
    circuit_id = '_'.join(parts[1:-1]).lower() if len(parts) > 2 else "circuit"
    circuits_svc = CircuitsService(DB_PATH, app_data)
    return await circuits_svc.get_session_drivers(circuit_id, session_id)


@app.get("/sessions/{session_id}/drivers/analytics")
@app.get("/api/sessions/{session_id}/drivers/analytics")
async def get_session_drivers_analytics_global(session_id: str):
    parts = session_id.split('_')
    circuit_id = '_'.join(parts[1:-1]).lower() if len(parts) > 2 else "circuit"
    circuits_svc = CircuitsService(DB_PATH, app_data)
    return await circuits_svc.get_session_drivers_analytics(circuit_id, session_id)


@app.get("/sessions/{session_id}/drivers/{driver_id}/analytics")
@app.get("/api/sessions/{session_id}/drivers/{driver_id}/analytics")
async def get_driver_analytics_global(session_id: str, driver_id: str):
    parts = session_id.split('_')
    circuit_id = '_'.join(parts[1:-1]).lower() if len(parts) > 2 else "circuit"
    circuits_svc = CircuitsService(DB_PATH, app_data)
    return await circuits_svc.get_driver_analytics(circuit_id, session_id, driver_id)


@app.get("/sessions/{session_id}/drivers/{driver_id}/laps")
@app.get("/api/sessions/{session_id}/drivers/{driver_id}/laps")
async def get_driver_laps_global(session_id: str, driver_id: str):
    parts = session_id.split('_')
    circuit_id = '_'.join(parts[1:-1]).lower() if len(parts) > 2 else "circuit"
    circuits_svc = CircuitsService(DB_PATH, app_data)
    return await circuits_svc.get_driver_laps(circuit_id, session_id, driver_id)


@app.get("/sessions/{session_id}/drivers/{driver_id}/stints")
@app.get("/api/sessions/{session_id}/drivers/{driver_id}/stints")
async def get_driver_stints_global(session_id: str, driver_id: str):
    parts = session_id.split('_')
    circuit_id = '_'.join(parts[1:-1]).lower() if len(parts) > 2 else "circuit"
    circuits_svc = CircuitsService(DB_PATH, app_data)
    return await circuits_svc.get_driver_stints(circuit_id, session_id, driver_id)


@app.get("/sessions/{session_id}/pit-stops")
@app.get("/api/sessions/{session_id}/pit-stops")
async def get_session_pit_stops_global(session_id: str):
    parts = session_id.split('_')
    circuit_id = '_'.join(parts[1:-1]).lower() if len(parts) > 2 else "circuit"
    circuits_svc = CircuitsService(DB_PATH, app_data)
    return await circuits_svc.get_session_pit_stops(circuit_id, session_id)


@app.get("/sessions/{session_id}/driver-advisory")
@app.get("/api/sessions/{session_id}/driver-advisory")
async def get_driver_advisory_global(session_id: str, driver_id: str = None, lap: int = None, current_lap: int = None):
    from api.services.driver_advisory_service import DriverAdvisoryService
    effective_lap = lap if lap is not None else current_lap
    adv_svc = DriverAdvisoryService(DB_PATH, app_data)
    return adv_svc.get_driver_advisory(session_id, driver_id, effective_lap)


@app.websocket("/ws/stints/{stint_id}/live")
async def live_stint_socket(websocket: WebSocket, stint_id: str):
    await websocket.accept()
    registry = get_model_registry()
    try:
        if stint_id in app_data["ledger"]:
            await websocket.send_json({
                "type": "ledger_snapshot",
                "stint_id": stint_id,
                "model_version": app_data["active_models"].get(1, "v3_stage1_2026-09-07"),
                "series": app_data["ledger"][stint_id]
            })
        
        while True:
            msg = await websocket.receive_json()
            msg_type = msg.get("type")
            
            if msg_type == "counterfactual":
                start_time = time.perf_counter()
                feature = msg.get("feature", "braking_aggression")
                delta_pct = float(msg.get("delta_pct", 0.0))
                
                stage3_version = app_data["active_models"].get(3, "v5_tcn_stage3_2026-09-07")
                avg_feat_val = app_data["stint_feature_means"].get(stint_id, {}).get(feature, 0.0)
                track_id = app_data["stint_track_map"].get(stint_id)
                
                coef = app_data["coefficients"].get((stage3_version, feature, track_id))
                if coef is None:
                    coef = app_data["coefficients"].get((stage3_version, feature, None))
                if coef is None:
                    coef = registry.get_coefficient(stage3_version, feature, track_id)
                
                seconds_debt_recovered = - (coef * (delta_pct / 100.0) * avg_feat_val)
                deg_per_lap = app_data["stint_avg_loss_per_lap"].get(stint_id, 0.1)
                stint_len = app_data.get("stint_lengths", {}).get(stint_id, 20)

                # Check bootstrap uncertainty table
                boot_lookup = app_data["bootstrap_uncertainty"].get((stint_id, feature, round(delta_pct, 1)))
                bootstrap_ci = (boot_lookup["ci_lower"], boot_lookup["ci_upper"]) if boot_lookup else None

                cf_eval = registry.behavioral_model.compute_counterfactual_recovery(
                    linear_loss_recovery=seconds_debt_recovered,
                    stint_length=stint_len,
                    deg_per_lap=deg_per_lap,
                    bootstrap_ci=bootstrap_ci
                )
                
                latency_ms = (time.perf_counter() - start_time) * 1000
                
                await websocket.send_json({
                    "type": "counterfactual_result",
                    "feature": feature,
                    "delta_pct": delta_pct,
                    "recovered_laps": cf_eval["recovered_laps"],
                    "ci_95": cf_eval["ci_95"],
                    "uncertainty_margin": cf_eval["uncertainty_margin"],
                    "uncertainty_method": cf_eval.get("uncertainty_method", "stint_cluster_bootstrap"),
                    "is_saturated": cf_eval["is_saturated"],
                    "model_version": stage3_version,
                    "compute_path": "websocket_live",
                    "measured_latency_ms": round(latency_ms, 3)
                })
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/physical-telemetry")
async def physical_telemetry_ws_root(websocket: WebSocket):
    """Authoritative root WebSocket route for live physical sensor telemetry fan-out."""
    service = get_physical_telemetry_service()
    await service.register_websocket(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        service.unregister_websocket(websocket)
    except Exception:
        service.unregister_websocket(websocket)
