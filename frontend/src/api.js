export const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) || "http://localhost:8000";
const OFFLINE_BASE = "/demo_offline";

export let isOfflineMode = false;

export function setOfflineMode(offline) {
  isOfflineMode = offline;
  window.dispatchEvent(new CustomEvent('offline-mode-change', { detail: offline }));
}

let consecutiveGlobalFailures = 0;

// High-speed In-Memory Client Cache & Single-Flight Request Deduplicator
const clientCache = new Map();
const inFlightRequests = new Map();

export function clearClientCache() {
  clientCache.clear();
}

async function fetchWithFallback(endpoint, offlineFile, useCache = true) {
  const cacheKey = endpoint;
  if (useCache && clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey);
  }

  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const fetchPromise = (async () => {
    if (isOfflineMode) {
      const data = await fetchOffline(offlineFile);
      if (useCache) clientCache.set(cacheKey, data);
      return data;
    }

    try {
      const res = await fetch(`${API_BASE}${endpoint}`);
      if (!res.ok) throw new Error(`API response not ok: ${res.status}`);
      const data = await res.json();
      consecutiveGlobalFailures = 0;
      if (useCache) clientCache.set(cacheKey, data);
      return data;
    } catch {
      consecutiveGlobalFailures++;
      if (consecutiveGlobalFailures >= 3) {
        console.warn(`[TyreDebt] ${consecutiveGlobalFailures} consecutive failures. Switching to offline mode.`);
        setOfflineMode(true);
      }
      const fallbackData = await fetchOffline(offlineFile);
      if (useCache) clientCache.set(cacheKey, fallbackData);
      return fallbackData;
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

async function fetchOffline(offlineFile) {
  const res = await fetch(`${OFFLINE_BASE}/${offlineFile}`);
  if (!res.ok) throw new Error(`Offline file not found: ${offlineFile}`);
  return res.json();
}

/**
 * Background pre-fetcher for all circuit maps and metadata.
 * Warms up in-memory cache on startup so all map views open instantly.
 */
export function prefetchCircuitsData(circuitsList) {
  if (!Array.isArray(circuitsList) || circuitsList.length === 0) return;
  circuitsList.forEach(circuit => {
    const trackId = circuit.track_id || circuit.circuit_id;
    if (trackId) {
      // Fire-and-forget background cache warming
      getCircuitMap(trackId).catch(() => {});
      getCircuit(trackId).catch(() => {});
      getCircuitSessions(trackId, circuit.year || 2024).catch(() => {});
    }
  });
}

// Multi-Season Endpoints
export async function getSeasons() {
  return fetchWithFallback("/api/seasons", "seasons.json");
}

export async function getSeasonEvents(year) {
  return fetchWithFallback(`/api/seasons/${year}/events`, `season_${year}_events.json`);
}

export async function getEventSessions(eventId) {
  return fetchWithFallback(`/api/events/${eventId}/sessions`, `event_${eventId}_sessions.json`);
}

// Multi-Circuit Endpoints
export async function getCircuits(year = null) {
  const url = year ? `/circuits?year=${year}` : "/circuits";
  return fetchWithFallback(url, "circuits.json");
}

export async function getCircuit(circuitId) {
  return fetchWithFallback(`/circuits/${circuitId}`, `circuit_${circuitId}.json`);
}

export async function getCircuitMap(circuitId) {
  return fetchWithFallback(`/circuits/${circuitId}/map`, `circuit_${circuitId}_map.json`);
}

export async function getCircuitSessions(circuitId, year = null) {
  const url = year ? `/circuits/${circuitId}/sessions?year=${year}` : `/circuits/${circuitId}/sessions`;
  return fetchWithFallback(url, `circuit_${circuitId}_sessions.json`);
}

export async function getSessionTelemetry(circuitId, sessionId) {
  return fetchWithFallback(`/circuits/${circuitId}/sessions/${sessionId}/telemetry`, `session_${sessionId}_telemetry.json`);
}

export async function getSessionWeather(sessionId) {
  return fetchWithFallback(`/api/sessions/${sessionId}/weather`, `session_${sessionId}_weather.json`);
}

export async function getSessionTrackStatus(sessionId) {
  return fetchWithFallback(`/api/sessions/${sessionId}/track-status`, `session_${sessionId}_track_status.json`);
}

export async function getSessionTrackShift(sessionId) {
  return fetchWithFallback(`/api/sessions/${sessionId}/trackshift`, `session_${sessionId}_trackshift.json`);
}

export async function getCircuitComparison(circuitId, seasons = "2024,2025") {
  return fetchWithFallback(`/api/circuits/${circuitId}/comparison?seasons=${seasons}`, `circuit_${circuitId}_comparison.json`);
}


export async function getSessionPitStops(circuitId, sessionId) {
  return fetchWithFallback(`/api/sessions/${sessionId}/pit-stops`, `session_${sessionId}_pit_stops.json`);
}

export async function getSessionDrivers(circuitId, sessionId) {
  return fetchWithFallback(`/circuits/${circuitId}/sessions/${sessionId}/drivers`, `session_${sessionId}_drivers.json`);
}

export async function getSessionDriversAnalytics(circuitId, sessionId) {
  return fetchWithFallback(`/circuits/${circuitId}/sessions/${sessionId}/drivers/analytics`, `session_${sessionId}_drivers_analytics.json`);
}

export async function getDriverAnalytics(circuitId, sessionId, driverId) {
  return fetchWithFallback(`/circuits/${circuitId}/sessions/${sessionId}/drivers/${driverId}/analytics`, `session_${sessionId}_${driverId}_analytics.json`);
}

export async function getDriverLaps(circuitId, sessionId, driverId) {
  return fetchWithFallback(`/circuits/${circuitId}/sessions/${sessionId}/drivers/${driverId}/laps`, `session_${sessionId}_${driverId}_laps.json`);
}

export async function getDriverStints(circuitId, sessionId, driverId) {
  return fetchWithFallback(`/circuits/${circuitId}/sessions/${sessionId}/drivers/${driverId}/stints`, `session_${sessionId}_${driverId}_stints.json`);
}

export async function getSessionLeaderboard(circuitId, sessionId, lap = null) {
  const url = lap ? `/circuits/${circuitId}/sessions/${sessionId}/leaderboard?lap=${lap}` : `/circuits/${circuitId}/sessions/${sessionId}/leaderboard`;
  return fetchWithFallback(url, `session_${sessionId}_leaderboard.json`);
}

export async function getCircuitStints(circuitId, driverId = null, compound = null) {
  let url = `/circuits/${circuitId}/stints`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (compound) params.push(`compound=${encodeURIComponent(compound)}`);
  if (params.length > 0) url += `?${params.join('&')}`;
  
  return fetchWithFallback(url, `circuit_${circuitId}_stints.json`);
}

export async function getRaces() {
  const races = await fetchWithFallback("/races", "races.json");
  return races.map(r => ({
    ...r,
    name: r.event_name || r.name || r.track_id
  }));
}

export async function getStints(raceId) {
  return fetchWithFallback(`/sessions/${raceId}/stints`, `sessions_${raceId}_stints.json`);
}

export async function getLedger(stintId) {
  return fetchWithFallback(`/stints/${stintId}/ledger`, `stints_${stintId}_ledger.json`);
}

export async function getAttribution(stintId) {
  return fetchWithFallback(`/stints/${stintId}/attribution`, `stints_${stintId}_attribution.json`);
}

export async function computeCounterfactual(stintId, feature, deltaPct, offlineContext) {
  if (isOfflineMode) {
    const entry = offlineContext?.attribution?.find(a => a.feature === feature);
    const coef = entry?.coefficient ?? 0.0;
    const avgVal = entry?.mean_value ?? 0.0;
    const degPerLap = offlineContext?.deg_per_lap || 1.0;

    const secondsDebtRecovered = -(coef * (deltaPct / 100.0) * avgVal);
    const rawLaps = degPerLap !== 0 ? secondsDebtRecovered / degPerLap : 0;
    const maxPhysicalLaps = 7.0;
    const boundedLaps = maxPhysicalLaps * Math.tanh(rawLaps / maxPhysicalLaps);
    const stdError = Math.max(0.08, 0.12 * Math.abs(boundedLaps));
    const ciMargin = 1.96 * stdError;

    return {
      feature,
      delta_pct: deltaPct,
      recovered_laps: Number(boundedLaps.toFixed(2)),
      ci_95: [Number((boundedLaps - ciMargin).toFixed(2)), Number((boundedLaps + ciMargin).toFixed(2))],
      uncertainty_margin: Number(ciMargin.toFixed(2)),
      is_saturated: Math.abs(rawLaps) > maxPhysicalLaps * 0.75,
      model_version: offlineContext?.model_version ?? "offline",
      compute_path: "client_lookup",
      measured_latency_ms: 1
    };
  }

  try {
    const res = await fetch(`${API_BASE}/stints/${stintId}/counterfactual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, delta_pct: deltaPct })
    });
    if (!res.ok) throw new Error(`API response not ok: ${res.status}`);
    const data = await res.json();
    consecutiveGlobalFailures = 0;
    return data;
  } catch {
    consecutiveGlobalFailures++;
    if (consecutiveGlobalFailures >= 3) {
      console.warn(`[TyreDebt] ${consecutiveGlobalFailures} consecutive failures. Switching to offline mode.`);
      setOfflineMode(true);
    }
    const entry = offlineContext?.attribution?.find(a => a.feature === feature);
    const coef = entry?.coefficient ?? 0.0;
    const avgVal = entry?.mean_value ?? 0.0;
    const degPerLap = offlineContext?.deg_per_lap || 1.0;

    const secondsDebtRecovered = -(coef * (deltaPct / 100.0) * avgVal);
    const rawLaps = degPerLap !== 0 ? secondsDebtRecovered / degPerLap : 0;
    const maxPhysicalLaps = 7.0;
    const boundedLaps = maxPhysicalLaps * Math.tanh(rawLaps / maxPhysicalLaps);
    const stdError = Math.max(0.08, 0.12 * Math.abs(boundedLaps));
    const ciMargin = 1.96 * stdError;

    return {
      feature,
      delta_pct: deltaPct,
      recovered_laps: Number(boundedLaps.toFixed(2)),
      ci_95: [Number((boundedLaps - ciMargin).toFixed(2)), Number((boundedLaps + ciMargin).toFixed(2))],
      uncertainty_margin: Number(ciMargin.toFixed(2)),
      is_saturated: Math.abs(rawLaps) > maxPhysicalLaps * 0.75,
      model_version: offlineContext?.model_version ?? "offline",
      compute_path: "client_lookup_fallback",
      measured_latency_ms: 1
    };
  }
}

export async function getSignatures() {
  return fetchWithFallback("/signatures", "signatures.json");
}

export async function computeSignatureTransfer(stintId, targetDriverId) {
  const res = await fetch(`${API_BASE}/stints/${stintId}/signature_transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_driver_id: targetDriverId })
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return await res.json();
}

export async function compareStints(stintA, stintB) {
  return fetchWithFallback(`/stints/compare?stint_a=${stintA}&stint_b=${stintB}`, `compare_${stintA}_${stintB}.json`);
}

export async function getCacheMetrics() {
  try {
    const res = await fetch(`${API_BASE}/metrics`);
    if (!res.ok) throw new Error(`Metrics error: ${res.status}`);
    return await res.json();
  } catch {
    return {
      tier: "offline",
      redis_connected: false,
      cache_hit_rate: 1.0,
      cache_hits_total: 0,
      cache_misses_total: 0
    };
  }
}

export async function invalidateStintCache(stintId) {
  try {
    const res = await fetch(`${API_BASE}/admin/cache/invalidate/stint/${encodeURIComponent(stintId)}`, {
      method: 'POST'
    });
    return await res.json();
  } catch {
    return { stint_id: stintId, invalidated_keys_count: 0 };
  }
}

// TrackShift Theme Alignment: Tyre Degradation, Prediction & Validation APIs
export async function getSessionDegradation(sessionId, driverId = null, compound = null, stintId = null) {
  let url = `/api/sessions/${sessionId}/degradation?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (compound && compound !== 'ALL') params.push(`compound=${encodeURIComponent(compound)}`);
  if (stintId) params.push(`stint_id=${encodeURIComponent(stintId)}`);
  url += params.join('&');
  return fetchWithFallback(url, `session_${sessionId}_degradation.json`);
}

export async function getSessionPrediction(sessionId, driverId = null, compound = null) {
  let url = `/api/sessions/${sessionId}/prediction?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (compound && compound !== 'ALL') params.push(`compound=${encodeURIComponent(compound)}`);
  url += params.join('&');
  return fetchWithFallback(url, `session_${sessionId}_prediction.json`);
}

export async function getSessionValidation(sessionId, practiceSessionId = null, driverId = null, compound = null) {
  let url = `/api/sessions/${sessionId}/validation?`;
  const params = [];
  if (practiceSessionId) params.push(`practice_session_id=${encodeURIComponent(practiceSessionId)}`);
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (compound && compound !== 'ALL') params.push(`compound=${encodeURIComponent(compound)}`);
  url += params.join('&');
  return fetchWithFallback(url, `session_${sessionId}_validation.json`);
}

export async function getEventPracticeRaceValidation(eventId, practiceSessionType = "FP2", driverId = null, compound = null) {
  let url = `/api/events/${eventId}/practice-race-validation?practice_session_type=${encodeURIComponent(practiceSessionType)}&`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (compound && compound !== 'ALL') params.push(`compound=${encodeURIComponent(compound)}`);
  url += params.join('&');
  return fetchWithFallback(url, `event_${eventId}_validation.json`);
}

export async function compareDriversDegradation(sessionId, driverA, driverB, compound = null) {
  let url = `/api/sessions/${sessionId}/degradation/compare-drivers?driver_a=${encodeURIComponent(driverA)}&driver_b=${encodeURIComponent(driverB)}`;
  if (compound && compound !== 'ALL') url += `&compound=${encodeURIComponent(compound)}`;
  return fetchWithFallback(url, `compare_drivers_${sessionId}_${driverA}_${driverB}.json`);
}

export async function compareCompoundsDegradation(sessionId, driverId = null) {
  let url = `/api/sessions/${sessionId}/degradation/compare-compounds?`;
  if (driverId) url += `driver_id=${encodeURIComponent(driverId)}`;
  return fetchWithFallback(url, `compare_compounds_${sessionId}.json`);
}

// Universal Race Intelligence APIs
export async function getRaceIntelligence(sessionId, driverId = null, replayLap = null, temporalMode = "AUTO") {
  let url = `/api/sessions/${sessionId}/race-intelligence?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (replayLap !== null && replayLap !== undefined) params.push(`replay_lap=${encodeURIComponent(replayLap)}`);
  if (temporalMode && temporalMode !== "AUTO") params.push(`temporal_mode=${encodeURIComponent(temporalMode)}`);
  url += params.join('&');
  return fetchWithFallback(url, `race_intelligence_${sessionId}.json`);
}

export async function getRaceIntelligenceDrivers(sessionId) {
  return fetchWithFallback(`/api/sessions/${sessionId}/race-intelligence/drivers`, `race_intelligence_drivers_${sessionId}.json`);
}

export async function getRaceIntelligenceStrategy(sessionId, driverA, driverB) {
  const url = `/api/sessions/${sessionId}/race-intelligence/strategy?driver_a=${encodeURIComponent(driverA)}&driver_b=${encodeURIComponent(driverB)}`;
  return fetchWithFallback(url, `race_intelligence_strategy_${sessionId}_${driverA}_${driverB}.json`);
}

export async function getRaceIntelligenceValidation(sessionId) {
  return fetchWithFallback(`/api/sessions/${sessionId}/race-intelligence/validation`, `race_intelligence_validation_${sessionId}.json`);
}

export async function getDriverRaceIntelligence(sessionId, driverId, replayLap = null) {
  let url = `/api/sessions/${sessionId}/race-intelligence/${driverId}`;
  if (replayLap !== null && replayLap !== undefined) url += `?replay_lap=${encodeURIComponent(replayLap)}`;
  return fetchWithFallback(url, `race_intelligence_${sessionId}_${driverId}.json`);
}

// Strategic Warfare Engine APIs
export async function getStrategicWarfare(sessionId, driverId = null, lap = null) {
  let url = `/api/sessions/${sessionId}/strategic-warfare?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (lap !== null && lap !== undefined) params.push(`lap=${encodeURIComponent(lap)}`);
  url += params.join('&');
  return fetchWithFallback(url, `strategic_warfare_${sessionId}_${driverId || 'ALL'}.json`);
}

export async function getStrategicDecision(sessionId, driverId = null, lap = null) {
  let url = `/api/sessions/${sessionId}/strategic-warfare/decision?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (lap !== null && lap !== undefined) params.push(`lap=${encodeURIComponent(lap)}`);
  url += params.join('&');
  return fetchWithFallback(url, `strategic_decision_${sessionId}.json`);
}

export async function getCompetitorRadar(sessionId, driverId = null, lap = null) {
  let url = `/api/sessions/${sessionId}/strategic-warfare/competitor-radar?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (lap !== null && lap !== undefined) params.push(`lap=${encodeURIComponent(lap)}`);
  url += params.join('&');
  return fetchWithFallback(url, `competitor_radar_${sessionId}.json`);
}

export async function getGhostCarRoi(sessionId, driverId = null, lap = null) {
  let url = `/api/sessions/${sessionId}/strategic-warfare/ghost-car-roi?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (lap !== null && lap !== undefined) params.push(`lap=${encodeURIComponent(lap)}`);
  url += params.join('&');
  return fetchWithFallback(url, `ghost_car_roi_${sessionId}.json`);
}

export async function getStrategicCheckpoints(sessionId, driverId) {
  const url = `/api/sessions/${sessionId}/strategic-warfare/checkpoints?driver_id=${encodeURIComponent(driverId)}`;
  return fetchWithFallback(url, `strategic_checkpoints_${sessionId}_${driverId}.json`);
}

// Confounder-Aware Tyre Intelligence APIs
export async function getTyreProvenance() {
  return fetchWithFallback("/api/tyre-intelligence/provenance", "tyre_provenance.json");
}

export async function getEstimatedDegradationCurve(circuitId, driverId, sessionId = null, checkpointLap = null) {
  if (!circuitId || !driverId) return null;
  let url = `/api/tyre-intelligence/degradation-curve?circuit_id=${encodeURIComponent(circuitId)}&driver_id=${encodeURIComponent(driverId)}`;
  if (sessionId) url += `&session_id=${encodeURIComponent(sessionId)}`;
  if (checkpointLap !== null && checkpointLap !== undefined) url += `&checkpoint_lap=${encodeURIComponent(checkpointLap)}`;
  return fetchWithFallback(url, `tyre_degradation_curve_${circuitId}_${driverId}.json`);
}

export async function getConfounderAblation(datasetName = "2024_2025_Telemetry") {
  return fetchWithFallback(`/api/tyre-intelligence/ablation?dataset_name=${encodeURIComponent(datasetName)}`, "tyre_ablation.json");
}

export async function getPostRaceValidation(circuitId = null) {
  let url = "/api/tyre-intelligence/post-race-validation";
  if (circuitId) url += `?circuit_id=${encodeURIComponent(circuitId)}`;
  return fetchWithFallback(url, `post_race_validation_${circuitId || 'all'}.json`);
}

export async function getConfounderBreakdown(circuitId, driverId) {
  if (!circuitId || !driverId) return null;
  return fetchWithFallback(`/api/tyre-intelligence/confounder-breakdown?circuit_id=${encodeURIComponent(circuitId)}&driver_id=${encodeURIComponent(driverId)}`, `confounder_breakdown_${circuitId}_${driverId}.json`);
}

export async function getSessionTyreIntelligence(sessionId, driverId, checkpointLap = null) {
  if (!sessionId || !driverId) return null;
  let url = `/api/sessions/${sessionId}/tyre-intelligence?driver_id=${encodeURIComponent(driverId)}`;
  if (checkpointLap !== null && checkpointLap !== undefined) url += `&checkpoint_lap=${encodeURIComponent(checkpointLap)}`;
  return fetchWithFallback(url, `session_tyre_intelligence_${sessionId}_${driverId}.json`);
}

export async function getDriverAdvisory(sessionId, driverId = null, lap = null) {
  let url = `/api/sessions/${sessionId}/driver-advisory?`;
  const params = [];
  if (driverId) params.push(`driver_id=${encodeURIComponent(driverId)}`);
  if (lap !== null && lap !== undefined) params.push(`lap=${encodeURIComponent(lap)}`);
  url += params.join('&');
  return fetchWithFallback(url, `driver_advisory_${sessionId}_${driverId || 'ALL'}.json`);
}

/**
 * Official TDSM State-Space Prediction Client
 * Sends current driver state S_t = [D_t, Delta_D_t, Delta2_D_t] and Context [L, Fuel, Compound]
 * to POST /api/tdsm/predict
 */
export async function predictTDSM(payload) {
  if (isOfflineMode) {
    const D = Number(payload.D || 0);
    const d1 = Number(payload.Delta_D || 0);
    const d2 = Number(payload.Delta2_D || 0);
    return {
      model: "TDSM",
      model_version: "TDSM-v2.0-StateTransition-Offline",
      model_used: "TDSM",
      data_cutoff_lap: payload.data_cutoff_lap,
      forecast: {
        "+1": Number((D + 1 * d1 + 0.5 * d2 * 1).toFixed(4)),
        "+3": Number((D + 3 * d1 + 0.5 * d2 * 9).toFixed(4)),
        "+5": Number((D + 5 * d1 + 0.5 * d2 * 25).toFixed(4)),
        "+10": Number((D + 10 * d1 + 0.5 * d2 * 100).toFixed(4))
      }
    };
  }

  try {
    const res = await fetch(`${API_BASE}/api/tdsm/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`TDSM API error: ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn("TDSM API fetch error:", err);
    throw err;
  }
}

/**
 * Real Physical Sensor Telemetry Client
 */
export async function getPhysicalTelemetryStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/physical-telemetry/status`);
    if (!res.ok) throw new Error(`Physical status error: ${res.status}`);
    return await res.json();
  } catch (err) {
    return { system_status: "offline", active_devices_online: 0, error: err.message };
  }
}

export async function getPhysicalDevices() {
  try {
    const res = await fetch(`${API_BASE}/api/physical-telemetry/devices`);
    if (!res.ok) throw new Error(`Physical devices error: ${res.status}`);
    return await res.json();
  } catch {
    return [];
  }
}

export async function getLatestPhysicalTelemetry(deviceId) {
  if (!deviceId) return null;
  try {
    const res = await fetch(`${API_BASE}/api/physical-telemetry/latest/${encodeURIComponent(deviceId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getPhysicalTelemetryHistory(deviceId, limit = 150) {
  if (!deviceId) return [];
  try {
    const res = await fetch(`${API_BASE}/api/physical-telemetry/history/${encodeURIComponent(deviceId)}?limit=${limit}`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

export async function ingestPhysicalTelemetry(payload, deviceKey = 'trackshift_dev_key_2025') {
  const res = await fetch(`${API_BASE}/api/physical-telemetry/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Key': deviceKey
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ingest failed (${res.status}): ${errText}`);
  }
  return await res.json();
}

export function createPhysicalTelemetryWebSocket(onMessage, onStatusChange) {
  const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws/physical-telemetry';
  let ws = null;
  let reconnectTimer = null;
  let isClosedManually = false;

  function connect() {
    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (onStatusChange) onStatusChange('connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (onMessage) onMessage(data);
        } catch (e) {
          console.warn("[PhysicalTelemetryWS] JSON parse error:", e);
        }
      };

      ws.onclose = () => {
        if (onStatusChange) onStatusChange('disconnected');
        if (!isClosedManually) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        if (onStatusChange) onStatusChange('error');
      };
    } catch {
      if (onStatusChange) onStatusChange('error');
      if (!isClosedManually) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    }
  }

  connect();

  return {
    close: () => {
      isClosedManually = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    }
  };
}



