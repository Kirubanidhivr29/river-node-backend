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

function getNodeDistanceTrend() {
  const points = history
    .filter(h => h.lastUpdated && typeof h.ultrasonicDistanceCm === "number")
    .map(h => ({ t: Date.parse(h.lastUpdated), v: h.ultrasonicDistanceCm }));
  return computeSlopePerHour(points); // cm per hour (negative = water rising, since distance to water surface shrinks)
}

function computeFloodRiskPrediction() {
  const nodeDistSlopeCmPerHr = getNodeDistanceTrend(); // may be null

  // 1) Base score from current sensor water status (EMPTY/MEDIUM/HIGH)
  const statusBase = { EMPTY: 5, MEDIUM: 35, HIGH: 65 };
  let score = statusBase[latestReading.waterStatus] ?? 10;

  // 2) Trend adjustment: falling ultrasonic distance = rising water at the node
  if (nodeDistSlopeCmPerHr !== null && nodeDistSlopeCmPerHr < 0) {
    score += Math.max(0, Math.min(20, -nodeDistSlopeCmPerHr * 2));
  }

  // 3) Rain contribution
  if (latestReading.rainStatus === "HEAVY_RAIN") score += 20;
  else if (latestReading.rainStatus === "LIGHT_RAIN") score += 10;

  // 4) Structural/tilt flag — a disturbed pole is itself a risk signal
  if (typeof latestReading.tiltDeg === "number" && latestReading.tiltDeg > 12) score += 10;

  score = Math.max(0, Math.min(100, Math.round(score)));

  let riskLevel = "Low";
  if (score >= 80) riskLevel = "Critical";
  else if (score >= 55) riskLevel = "High";
  else if (score >= 30) riskLevel = "Moderate";

  // 5) Qualitative time estimate — we deliberately avoid a fabricated precise
  // ETA in hours here, since the node reports category (EMPTY/MEDIUM/HIGH)
  // rather than a calibrated distance-to-flood-level mapping. Instead we
  // describe how fast things are moving in plain terms.
  let trendDescription;
  if (latestReading.waterStatus === "HIGH") {
    trendDescription = "Water is already at HIGH level at the node.";
  } else if (nodeDistSlopeCmPerHr !== null && nodeDistSlopeCmPerHr < -5) {
    trendDescription = "Water is rising quickly — could reach the next alert level within the next hour or two if this continues.";
  } else if (nodeDistSlopeCmPerHr !== null && nodeDistSlopeCmPerHr < 0) {
    trendDescription = "Water is rising gradually — may take several hours to reach a higher alert level at this rate.";
  } else {
    trendDescription = "Water level is stable — no significant rise detected.";
  }

  const recommendations = {
    Low: "No action needed. Continue routine monitoring.",
    Moderate: "Monitor closely. Notify local flood watch coordinator.",
    High: "Prepare evacuation routes. Alert downstream residents.",
    Critical: "Immediate action: evacuate low-lying areas, notify authorities.",
  };

  // Confidence: more historical sensor readings = more confidence in the trend estimate.
  const totalReadings = history.length;
  let confidence;
  if (totalReadings < 2) confidence = 40;
  else if (totalReadings < 4) confidence = 60;
  else if (totalReadings < 8) confidence = 75;
  else if (totalReadings < 15) confidence = 85;
  else confidence = 93;

  // Human-readable narrative sentence describing the prediction.
  const causes = [];
  if (nodeDistSlopeCmPerHr !== null && nodeDistSlopeCmPerHr < 0) causes.push("the rising water level at the node");
  if (latestReading.rainStatus === "HEAVY_RAIN") causes.push("heavy rainfall");
  else if (latestReading.rainStatus === "LIGHT_RAIN") causes.push("ongoing light rainfall");

  let narrative;
  if (causes.length > 0 && riskLevel !== "Low") {
    const causeText = causes.join(" and ");
    narrative = `${causeText.charAt(0).toUpperCase() + causeText.slice(1)} indicate elevated flood risk. ${trendDescription}`;
  } else if (riskLevel === "Low") {
    narrative = `Conditions are stable. ${trendDescription}`;
  } else {
    narrative = trendDescription;
  }

  return {
    riskScore: score,
    riskLevel,
    confidence,
    narrative,
    nodeDistanceTrendCmPerHour: nodeDistSlopeCmPerHr !== null ? Math.round(nodeDistSlopeCmPerHr * 100) / 100 : null,
    recommendation: recommendations[riskLevel],
    basedOn: {
      nodeReadings: history.length,
    },
    computedAt: new Date().toISOString(),
  };
}

// ============================================================
// Rule-based AI Assistant (no external API/LLM — free, offline-safe)
// ============================================================
// Answers common questions using live sensor + prediction data.
// Matches on keywords rather than a generative model, so it's fast, has
// zero cost, and never depends on an internet API call during a demo.
function generateAssistantReply(message) {
  const msg = (message || "").toLowerCase();
  const pred = computeFloodRiskPrediction();
  const alertLevel = latestReading.alertLevel || "OK";
  const waterStatus = latestReading.waterStatus || "unknown";

  const isSafeQuestion = /safe|risk|danger/.test(msg);
  const isFloodQuestion = /flood|overflow|today|occur/.test(msg);
  const isPrecautionQuestion = /precaution|prepare|should i do|advice|action/.test(msg);
  const isWhyRisingQuestion = /why.*(rising|increas)|water level.*(rising|increas)/.test(msg);

  if (isWhyRisingQuestion) {
    if (pred.nodeDistanceTrendCmPerHour !== null && pred.nodeDistanceTrendCmPerHour < 0) {
      const rainNote = latestReading.rainStatus === "HEAVY_RAIN"
        ? " combined with heavy rainfall at the node"
        : latestReading.rainStatus === "LIGHT_RAIN"
        ? " combined with light ongoing rainfall"
        : "";
      return `The river node shows water rising (distance closing at about ${Math.abs(pred.nodeDistanceTrendCmPerHour)} cm/hour)${rainNote}.`;
    }
    return "The river node isn't showing a clear rising trend right now — it may be stable or we don't have enough recent readings yet.";
  }

  if (isFloodQuestion) {
    return `Current flood risk is assessed as ${pred.riskLevel} (score ${pred.riskScore}/100). ${pred.narrative}`;
  }

  if (isSafeQuestion) {
    if (alertLevel === "OK" && waterStatus !== "HIGH") {
      return `Conditions look normal right now — water status is "${waterStatus}" and the river node reports no active alert. Risk score: ${pred.riskScore}/100 (${pred.riskLevel}).`;
    }
    return `Caution advised — water status is "${waterStatus}" and the river node alert is "${alertLevel}". Risk score: ${pred.riskScore}/100 (${pred.riskLevel}). ${pred.recommendation}`;
  }

  if (isPrecautionQuestion) {
    return pred.recommendation;
  }

  // Fallback: general status summary
  return `Status summary — Water status: ${waterStatus}. River node alert: ${alertLevel}. AI risk score: ${pred.riskScore}/100 (${pred.riskLevel}). Ask me things like "is my area safe?" or "will flooding occur today?"`;
}

// --- AI flood risk prediction endpoint ---
app.get("/api/predict", (req, res) => {
  res.json(computeFloodRiskPrediction());
});

// --- Rule-based assistant endpoint ---
app.post("/api/assistant", (req, res) => {
  const message = (req.body && req.body.message) || "";
  const reply = generateAssistantReply(message);
  res.json({ reply });
});

// Simple health check (useful for confirming the cloud deploy is alive)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`River Node backend running on port ${PORT}`);
});
