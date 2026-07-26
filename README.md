# River Node — Backend + Installable App

This gives you three things:
1. A backend server (`server.js`) that receives readings from your LoRa gateway and stores the latest one.
2. A dashboard (`public/index.html`) served by that same backend — no more `file://`.
3. That dashboard is a PWA, so it can be **installed on your phone home screen** like a real app.

## 1. Deploy the backend (free, ~5 minutes)

Using **Render.com** (free tier, no credit card needed for this):

1. Go to https://render.com and sign up / log in.
2. Push this folder to a new GitHub repo (or use Render's "Upload" option if available).
3. In Render: **New +** → **Web Service** → connect your repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
5. Deploy. Render gives you a URL like:
   `https://river-node-xxxx.onrender.com`

That URL is now your dashboard AND your API, live on the internet, from anywhere.

> Note: Render's free tier "sleeps" after 15 min of no traffic and takes ~30-60 sec to
> wake up on the next request. Fine for a demo you control, just hit the URL once
> a minute or two before you present to "wake it up."

## 2. Point your Gateway ESP32 at it

Your gateway (ESP32 + LoRa + WiFi) should, after receiving each LoRa packet from the
sensor node, do an HTTP POST like this:

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* ssid = "YOUR_WIFI";
const char* password = "YOUR_WIFI_PASSWORD";
const char* serverUrl = "https://river-node-xxxx.onrender.com/api/reading";

void sendReading(float waterLevelCm, float ultrasonicCm, int rain,
                  float tiltDeg, int battery, int rssi, float lat, float lng) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"waterLevelCm\":" + String(waterLevelCm) + ",";
  payload += "\"ultrasonicDistanceCm\":" + String(ultrasonicCm) + ",";
  payload += "\"rain\":" + String(rain) + ",";
  payload += "\"tiltDeg\":" + String(tiltDeg) + ",";
  payload += "\"battery\":" + String(battery) + ",";
  payload += "\"loraRssi\":" + String(rssi) + ",";
  payload += "\"gps\":{\"lat\":" + String(lat, 6) + ",\"lng\":" + String(lng, 6) + "}";
  payload += "}";

  int code = http.POST(payload);
  Serial.printf("POST response: %d\n", code);
  http.end();
}
```

Call `sendReading(...)` each time the gateway parses a fresh LoRa packet from the
sensor node.

## 3. Install it as an app on your phone

Once deployed:
1. Open the Render URL on your phone in Chrome (Android) or Safari (iPhone).
2. **Android/Chrome:** tap the menu (⋮) → "Install app" (or you'll see an automatic prompt).
3. **iPhone/Safari:** tap Share → "Add to Home Screen".
4. It now opens full-screen with its own icon, no browser bar — feels like a native app.

## Local testing before you deploy

```bash
npm install
npm start
```
Then open `http://localhost:3000` in your browser. Test posting fake data with:

```bash
curl -X POST http://localhost:3000/api/reading \
  -H "Content-Type: application/json" \
  -d '{"waterLevelCm":42.5,"ultrasonicDistanceCm":57.5,"rain":1,"tiltDeg":3.2,"battery":87,"loraRssi":-62,"gps":{"lat":13.0827,"lng":80.2707}}'
```
Refresh the dashboard — it should update within 3 seconds.

## Files

```
river-node-backend/
├── server.js           <- backend server
├── package.json
├── public/
│   ├── index.html       <- the app UI (PWA)
│   ├── manifest.json    <- makes it installable
│   ├── service-worker.js
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```
