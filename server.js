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
  tiltDeg: null,
  battery: null,
  loraRssi: null,
  gps: { lat: null, lng: null },
  lastUpdated: null,
};

// Keep a short rolling history for the chart (last 50 readings)
const history = [];
const MAX_HISTORY = 50;

// --- Gateway posts new sensor data here ---
// Example body:
// {
//   "waterLevelCm": 42.5,
//   "ultrasonicDistanceCm": 57.5,
//   "rain": 1,
//   "tiltDeg": 3.2,
//   "battery": 87,
//   "loraRssi": -62,
//   "gps": { "lat": 13.0827, "lng": 80.2707 }
// }
app.post("/api/reading", (req, res) => {
  const body = req.body || {};

  latestReading = {
    waterLevelCm: body.waterLevelCm ?? latestReading.waterLevelCm,
    ultrasonicDistanceCm: body.ultrasonicDistanceCm ?? latestReading.ultrasonicDistanceCm,
    rain: body.rain ?? latestReading.rain,
    tiltDeg: body.tiltDeg ?? latestReading.tiltDeg,
    battery: body.battery ?? latestReading.battery,
    loraRssi: body.loraRssi ?? latestReading.loraRssi,
    gps: body.gps ?? latestReading.gps,
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

// Simple health check (useful for confirming the cloud deploy is alive)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`River Node backend running on port ${PORT}`);
});
