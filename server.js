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

// Simple health check (useful for confirming the cloud deploy is alive)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`River Node backend running on port ${PORT}`);
});
