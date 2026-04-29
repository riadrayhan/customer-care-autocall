# AutoCall Flutter Client

Receives auto-calls from the AutoCall backend over WebRTC and plays the admin's live voice (e.g. Bangla EMI reminder).

## Quick start

```bash
flutter pub get
flutter run
```

## Android setup

In `android/app/src/main/AndroidManifest.xml`, inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.RECORD_AUDIO"/>
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>
<uses-permission android:name="android.permission.WAKE_LOCK"/>
<uses-permission android:name="android.permission.BLUETOOTH"/>
```

On the `<application>` tag (only for HTTP local dev):
```xml
android:usesCleartextTraffic="true"
```

In `android/app/build.gradle`, set `minSdkVersion 23` (required by `flutter_webrtc`).

## iOS setup

In `ios/Runner/Info.plist`:
```xml
<key>NSMicrophoneUsageDescription</key>
<string>Used for customer support calls.</string>
<key>NSCameraUsageDescription</key>
<string>Used for video calls.</string>
```

In `ios/Podfile`, target iOS 12+:
```ruby
platform :ios, '12.0'
```

## Connecting

- **Server URL**:
  - Android emulator → `http://10.0.2.2:3000`
  - iOS simulator   → `http://localhost:3000`
  - Real device     → `http://<your-LAN-ip>:3000` or `https://<your-app>.onrender.com`
- **User ID**: must match a seeded user (e.g. `user-001` … `user-005`)

## Architecture

```
HomeScreen ──connect──▶ CallService (Socket.io + WebRTC)
                            │
                  incoming_call event
                            ▼
                  IncomingCallScreen (Accept / Reject)
                            │
                            ▼
                  WebRTC offer/answer + ICE → audio plays
```
