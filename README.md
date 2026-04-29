# AutoCall — Smart Customer Support System

Real two-way internet calls (WebRTC) triggered from an admin panel to Flutter mobile users.
Use case: **automated EMI payment reminders in Bangla** — admin clicks "Call", user's phone rings, user picks up, and admin's voice (or pre-recorded message) plays live.

```
┌──────────────────┐        ┌─────────────────────┐        ┌──────────────────┐
│   Admin Panel    │        │   Node.js Backend   │        │  Flutter Client  │
│  (browser, mic)  │◀──────▶│  Socket.io + REST   │◀──────▶│  (mobile, WebRTC)│
│  public/admin.html│       │   src/server.js     │        │  flutter_client/ │
└──────────────────┘        └──────────┬──────────┘        └──────────────────┘
                                       │
                            STUN/TURN (Google STUN by default)
```

## Features

- ✅ JWT-auth admin login
- ✅ Live user list with online/offline + EMI-due badges
- ✅ One-click call / bulk call / **auto-call all EMI-due users**
- ✅ Real WebRTC two-way audio (browser ↔ mobile)
- ✅ Auto-generated Bangla message per user (overdue / today / upcoming)
- ✅ 30 s ring timeout, retry queue (max 3, 60 s delay), call history, stats
- ✅ ICE restart on network change

---

## 1. Run the backend

```powershell
cd autocall-backend
npm install
npm run dev      # nodemon, http://localhost:3000
```

Open the **admin panel**: <http://localhost:3000/admin.html>
Login: `admin / admin123` (seed in `src/controllers/authController.js`)

API docs: <http://localhost:3000/api/docs>

---

## 2. Run the Flutter client

```powershell
cd flutter_client
flutter pub get
flutter run
```

In the app:
- **Server URL** — `http://10.0.2.2:3000` (Android emulator) or your LAN IP `http://192.168.x.x:3000` (real device) or `https://your-app.onrender.com` (production)
- **User ID** — must match a user in `src/utils/userStore.js` (e.g. `user-001`)
- Tap **Connect & Listen** → app stays online → admin panel can ring it

### Required Android permissions
Already wired via `permission_handler`. Add to `android/app/src/main/AndroidManifest.xml`:
```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.WAKE_LOCK"/>
<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
```
For HTTP (non-HTTPS) during local dev, also set `android:usesCleartextTraffic="true"` on `<application>`.

### iOS — `ios/Runner/Info.plist`
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Required for support calls</string>
<key>NSCameraUsageDescription</key>
<string>Required for video calls</string>
```

---

## 3. Deploy to Render

`render.yaml` is ready. Push to GitHub and connect on render.com.
Set in Render dashboard:
- `ADMIN_PASSWORD` (secret)
- *(Optional but recommended for real-world calls behind NAT)* `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` — get free TURN from [Metered](https://www.metered.ca/tools/openrelay/) or run your own coturn.

> **STUN alone is NOT enough** for ~20 % of mobile networks (CGNAT). For a production product targeting real customers, **add a TURN server** — otherwise calls will fail to connect on some carriers.

After deploy, point Flutter app's **Server URL** to `https://your-app.onrender.com`.

---

## 4. Call flow internals

| Step | Actor | Event |
|---|---|---|
| 1 | Admin clicks *Call* | `POST /api/calls/initiate` *or* `socket.emit('initiate_call')` |
| 2 | Server | `incoming_call` → user socket |
| 3 | Flutter user taps Accept | `call_answer` |
| 4 | Server | joins both into `call:<callId>` room |
| 5 | Admin browser | `getUserMedia` → `createOffer` → `webrtc_offer` |
| 6 | Flutter | `setRemoteDescription` → `createAnswer` → `webrtc_answer` |
| 7 | Both | exchange `ice_candidate` until connected |
| 8 | Audio flows P2P | (TURN-relayed if NAT blocks direct) |
| 9 | Either side | `end_call` → server logs `call_ended` |

---

## 5. Production hardening (TODO before real users)

- [ ] Replace in-memory `userStore` with PostgreSQL/MongoDB
- [ ] Replace hardcoded `ADMINS` array with DB + bcrypt
- [ ] Add TURN server (mandatory)
- [ ] Add background-call support on Android via `flutter_callkit_incoming` + FCM data push so the phone rings even when app is killed
- [ ] Add call recording (server-side via `mediasoup` SFU if needed)
- [ ] Rate-limit per-admin call initiation
- [ ] Encrypt JWT secret + rotate
