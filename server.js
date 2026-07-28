// River Node Backend Server
// Receives sensor data from the LoRa Gateway (ESP32 + WiFi) and serves it
// to the dashboard / mobile app.

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Serve the dashboard (index.html, manifest.json, service-worker.js, etc.)
app.use(express.static(path.join(__dirname, "public")));

// In-memory store for the latest reading.
// Good enough for a contest demo; swap for a database later if you want history beyond
// what /api/history keeps.
let latestReading = {
  waterLevelCm: null,
  ultrasonicDistanceCm: null,
  rain: null,
  rainStatus: null,
  waterStatus: null,
  tiltDeg: null,
  battery: null,
  loraRssi: null,
  turbidity: null,
  turbidityStatus: null,
  gps: { lat: null, lng: null },
  alertLevel: "OK",
  alertMessage: "Normal",
  lastUpdated: null,
};

// Keep a short rolling history for the chart (last 50 readings)
const history = [];
const MAX_HISTORY = 50;

// --- Chembarambakkam Reservoir: static reference data ---
const RESERVOIR_INFO = {
  name: "Chembarambakkam",
  fullReservoirLevelFt: 85.40,
  oldGaugeFullLevelFt: 24,
  fullStorageCapacityMcft: 3645,
  riverConnected: "Adyar River",
  maximumSafeStorageMcft: 3645,
  district: "Chennai",
  latitude: 13.010,
  longitude: 80.060,
};

// --- Flood threshold table (configurable — edit these ranges anytime) ---
const FLOOD_THRESHOLDS = [
  { level: "Overflow", minFt: 85.4, maxFt: Infinity, status: "Red",    alert: "Emergency" },
  { level: "Critical", minFt: 84,   maxFt: 85.4,     status: "Red",    alert: "High Risk" },
  { level: "Warning",  minFt: 80,   maxFt: 84,       status: "Orange", alert: "Prepare" },
  { level: "Watch",    minFt: 75,   maxFt: 80,       status: "Yellow", alert: "Monitor" },
  { level: "Normal",   minFt: -Infinity, maxFt: 75,  status: "Green",  alert: "No" },
];

function computeReservoirStatus(waterLevelFt) {
  for (const t of FLOOD_THRESHOLDS) {
    if (waterLevelFt >= t.minFt && waterLevelFt < t.maxFt) {
      return { level: t.level, status: t.status, alert: t.alert };
    }
  }
  return { level: "Normal", status: "Green", alert: "No" };
}

// Current reservoir reading — update this via POST /api/reservoir
let currentReservoir = {
  waterLevelFt: null,
  storagePercent: null,
  rainfallLast24hMm: null,
  inflowCusecs: null,
  outflowCusecs: null,
  level: null,
  status: null,
  alert: null,
  lastUpdated: null,
};

const reservoirHistory = [];
const MAX_RESERVOIR_HISTORY = 100;


// --- Alert logic ---
// Checked from most severe to least severe, so a single reading only ever
// triggers the highest-priority match.
//
// | Water Level | Tilt  | Rain    | Action                                     |
// |-------------|-------|---------|--------------------------------------------|
// | High        | >15°  | Heavy   | Critical: Pole may collapse or be swept away |
// | High        | >12°  | Heavy   | Flood + Structure Alert                     |
// | Normal      | >12°  | No Rain | Possible vandalism or loose mounting        |
// | High        | Normal| Heavy   | Flood Warning                               |
function computeAlert(waterStatus, tiltDeg, rainStatus) {
  // Your sensor node reports EMPTY / MEDIUM / HIGH — only HIGH counts as
  // "High" in the table below. Change this line if you want MEDIUM included too.
  const isHighWater = waterStatus === "HIGH";
  const isHeavyRain = rainStatus === "HEAVY_RAIN";
  const isNoRain = rainStatus === "NO_RAIN";
  const tilt = typeof tiltDeg === "number" ? tiltDeg : 0;

  if (isHighWater && tilt > 15 && isHeavyRain) {
    return { level: "CRITICAL", message: "Critical: Pole may collapse or be swept away" };
  }
  if (isHighWater && tilt > 12 && isHeavyRain) {
    return { level: "HIGH", message: "Flood + Structure Alert" };
  }
  if (!isHighWater && tilt > 12 && isNoRain) {
    return { level: "WARNING", message: "Possible vandalism or loose mounting" };
  }
  if (isHighWater && tilt <= 12 && isHeavyRain) {
    return { level: "WARNING", message: "Flood Warning" };
  }
  return { level: "OK", message: "Normal" };
}

// --- Gateway posts new sensor data here ---
app.post("/api/reading", (req, res) => {
  const body = req.body || {};

  const alert = computeAlert(body.waterStatus, body.tiltDeg, body.rainStatus);

  latestReading = {
    waterLevelCm: body.waterLevelCm ?? latestReading.waterLevelCm,
    ultrasonicDistanceCm: body.ultrasonicDistanceCm ?? latestReading.ultrasonicDistanceCm,
    rain: body.rain ?? latestReading.rain,
    rainStatus: body.rainStatus ?? latestReading.rainStatus,
    waterStatus: body.waterStatus ?? latestReading.waterStatus,
    tiltDeg: body.tiltDeg ?? latestReading.tiltDeg,
    battery: body.battery ?? latestReading.battery,
    loraRssi: body.loraRssi ?? latestReading.loraRssi,
    turbidity: body.turbidity ?? latestReading.turbidity,
    turbidityStatus: body.turbidityStatus ?? latestReading.turbidityStatus,
    gps: body.gps ?? latestReading.gps,
    alertLevel: alert.level,
    alertMessage: alert.message,
    lastUpdated: new Date().toISOString(),
  };

  history.push(latestReading);
  if (history.length > MAX_HISTORY) history.shift();

  console.log("New reading received:", latestReading);
  res.json({ ok: true });
});

// --- App / dashboard polls this for the latest reading ---
app.get("/api/latest", (req, res) => {
  res.json(latestReading);
});

// --- App / dashboard fetches this for the chart ---
app.get("/api/history", (req, res) => {
  res.json(history);
});

// --- Reservoir: static info + threshold table (rarely changes) ---
app.get("/api/reservoir/info", (req, res) => {
  res.json({ info: RESERVOIR_INFO, thresholds: FLOOD_THRESHOLDS });
});

// --- Reservoir: update the current level ---
// Example body:
// {
//   "waterLevelFt": 82.3,
//   "storagePercent": 88,
//   "rainfallLast24hMm": 40,
//   "inflowCusecs": 1200,
//   "outflowCusecs": 800
// }
app.post("/api/reservoir", (req, res) => {
  const body = req.body || {};
  const waterLevelFt = body.waterLevelFt ?? currentReservoir.waterLevelFt;
  const computed = computeReservoirStatus(waterLevelFt);

  currentReservoir = {
    waterLevelFt,
    storagePercent: body.storagePercent ?? currentReservoir.storagePercent,
    rainfallLast24hMm: body.rainfallLast24hMm ?? currentReservoir.rainfallLast24hMm,
    inflowCusecs: body.inflowCusecs ?? currentReservoir.inflowCusecs,
    outflowCusecs: body.outflowCusecs ?? currentReservoir.outflowCusecs,
    level: computed.level,
    status: computed.status,
    alert: computed.alert,
    lastUpdated: new Date().toISOString(),
  };

  reservoirHistory.push(currentReservoir);
  if (reservoirHistory.length > MAX_RESERVOIR_HISTORY) reservoirHistory.shift();

  console.log("Reservoir updated:", currentReservoir);
  res.json({ ok: true, reservoir: currentReservoir });
});

// --- Reservoir: get current level + status ---
app.get("/api/reservoir", (req, res) => {
  res.json(currentReservoir);
});

// --- Reservoir: history ---
app.get("/api/reservoir/history", (req, res) => {
  res.json(reservoirHistory);
});

// ============================================================
// AI Flood Risk Prediction (trend-based, no external ML needed)
// ============================================================
// Uses simple linear regression on recent history to estimate how fast
// water levels are rising/falling, then combines that trend with the
// current status to produce a 0-100 risk score, a risk level, and an
// ETA (in hours) to the next threshold being crossed.

// Least-squares slope of y over x, where x is in hours.
// points: [{ t: <ms timestamp>, v: <number> }]
// Returns null if fewer than 2 valid points.
function computeSlopePerHour(points) {
  const valid = points.filter(p => typeof p.v === "number" && !isNaN(p.v) && typeof p.t === "number");
  if (valid.length < 2) return null;

  const t0 = valid[0].t;
  const xs = valid.map(p => (p.t - t0) / 3600000); // ms -> hours
  const ys = valid.map(p => p.v);

  const n = xs.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0) return 0; // no time spread yet
  return num / den;
}

// Ascending reservoir thresholds, used to find "how far to the next tier up"
const RESERVOIR_TIERS_ASC = [
  { level: "Normal", upperFt: 75 },
  { level: "Watch", upperFt: 80 },
  { level: "Warning", upperFt: 84 },
  { level: "Critical", upperFt: 85.4 },
  { level: "Overflow", upperFt: Infinity },
];

function getReservoirTrend() {
  const points = reservoirHistory
    .filter(r => r.lastUpdated && typeof r.waterLevelFt === "number")
    .map(r => ({ t: Date.parse(r.lastUpdated), v: r.waterLevelFt }));
  return computeSlopePerHour(points); // ft per hour
}

function getNodeDistanceTrend() {
  const points = history
    .filter(h => h.lastUpdated && typeof h.ultrasonicDistanceCm === "number")
    .map(h => ({ t: Date.parse(h.lastUpdated), v: h.ultrasonicDistanceCm }));
  return computeSlopePerHour(points); // cm per hour (negative = water rising)
}

function computeFloodRiskPrediction() {
  const reservoirSlopeFtPerHr = getReservoirTrend(); // may be null
  const nodeDistSlopeCmPerHr = getNodeDistanceTrend(); // may be null

  // 1) Base score from current reservoir tier
  const tierBase = {
    Normal: 10, Watch: 35, Warning: 60, Critical: 85, Overflow: 100,
  };
  let score = tierBase[currentReservoir.level] ?? 10;

  // 2) Reservoir trend adjustment: reward/penalize based on rise rate
  if (reservoirSlopeFtPerHr !== null) {
    score += Math.max(-15, Math.min(20, reservoirSlopeFtPerHr * 20));
  }

  // 3) River node trend: falling distance = rising water at the node
  if (nodeDistSlopeCmPerHr !== null && nodeDistSlopeCmPerHr < 0) {
    score += Math.max(-15, Math.min(15, -nodeDistSlopeCmPerHr * 1.5));
  }

  // 4) Rain contribution
  if (latestReading.rainStatus === "HEAVY_RAIN") score += 10;
  else if (latestReading.rainStatus === "LIGHT_RAIN") score += 5;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let riskLevel = "Low";
  if (score >= 80) riskLevel = "Critical";
  else if (score >= 55) riskLevel = "High";
  else if (score >= 30) riskLevel = "Moderate";

  // 5) ETA to next reservoir tier, if rising and we have a level reading
  let etaHours = null;
  let etaNextLevel = null;
  if (
    reservoirSlopeFtPerHr !== null &&
    reservoirSlopeFtPerHr > 0.01 &&
    typeof currentReservoir.waterLevelFt === "number"
  ) {
    const currentTierIdx = RESERVOIR_TIERS_ASC.findIndex(
      t => currentReservoir.waterLevelFt < t.upperFt
    );
    if (currentTierIdx !== -1 && currentTierIdx < RESERVOIR_TIERS_ASC.length - 1) {
      const nextTier = RESERVOIR_TIERS_ASC[currentTierIdx];
      const ftToGo = nextTier.upperFt - currentReservoir.waterLevelFt;
      etaHours = Math.round((ftToGo / reservoirSlopeFtPerHr) * 10) / 10;
      etaNextLevel = RESERVOIR_TIERS_ASC[currentTierIdx + 1]?.level ?? nextTier.level;
    }
  }

  const recommendations = {
    Low: "No action needed. Continue routine monitoring.",
    Moderate: "Monitor closely. Notify local flood watch coordinator.",
    High: "Prepare evacuation routes. Alert downstream residents.",
    Critical: "Immediate action: evacuate low-lying areas, notify authorities.",
  };

  return {
    riskScore: score,
    riskLevel,
    reservoirTrendFtPerHour: reservoirSlopeFtPerHr !== null ? Math.round(reservoirSlopeFtPerHr * 100) / 100 : null,
    nodeDistanceTrendCmPerHour: nodeDistSlopeCmPerHr !== null ? Math.round(nodeDistSlopeCmPerHr * 100) / 100 : null,
    etaHoursToNextLevel: etaHours,
    etaNextLevel,
    recommendation: recommendations[riskLevel],
    basedOn: {
      reservoirReadings: reservoirHistory.length,
      nodeReadings: history.length,
    },
    computedAt: new Date().toISOString(),
  };
}

// --- AI flood risk prediction endpoint ---
app.get("/api/predict", (req, res) => {
  res.json(computeFloodRiskPrediction());
});

// Simple health check (useful for confirming the cloud deploy is alive)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`River Node backend running on port ${PORT}`);
});