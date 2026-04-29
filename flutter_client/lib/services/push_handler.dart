/// push_handler.dart
/// Wires Firebase Cloud Messaging to flutter_callkit_incoming so the
/// device rings (and shows full-screen lockscreen UI) even when the
/// app is killed.
///
/// SETUP:
///   1. Run `flutterfire configure` after adding google-services.json (Android)
///      and GoogleService-Info.plist (iOS).
///   2. The backend's pushService sends FCM data-only messages with:
///        type=incoming_call, callId, callerName, message, retryCount
///   3. On message receipt (foreground or background), CallKit shows ringing UI.
///   4. When the user accepts and the app is launched, CallService picks up
///      the in-flight `currentCall` from CallKit events.
library;

import 'dart:async';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'callkit_helper.dart';

/// MUST be a top-level function for FCM background handler.
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();
  await _showCallKitFromMessage(message);
}

Future<void> _showCallKitFromMessage(RemoteMessage message) async {
  final data = message.data;
  if (data['type'] != 'incoming_call') return;
  final callId = data['callId'] ?? '';
  if (callId.isEmpty) return;
  await CallKitHelper.showIncoming(
    callId: callId,
    callerName: data['callerName'] ?? 'Customer Support',
    handle: data['message'],
  );
}

class PushHandler {
  static bool _initialized = false;
  static String? currentToken;
  static final _tokenController = StreamController<String>.broadcast();
  static Stream<String> get tokenStream => _tokenController.stream;

  /// Call from main() before runApp() — only once.
  static Future<void> init() async {
    if (_initialized) return;
    _initialized = true;

    try {
      await Firebase.initializeApp();
    } catch (e) {
      debugPrint('[Push] Firebase init failed (will run without push): $e');
      return;
    }

    final messaging = FirebaseMessaging.instance;

    // iOS / Android 13+ permission
    final settings = await messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );
    debugPrint('[Push] permission: ${settings.authorizationStatus}');

    // Background isolate handler
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    // Foreground messages
    FirebaseMessaging.onMessage.listen((m) async {
      debugPrint('[Push] foreground message: ${m.data}');
      await _showCallKitFromMessage(m);
    });

    // Token refresh
    messaging.onTokenRefresh.listen((t) {
      currentToken = t;
      _tokenController.add(t);
      debugPrint('[Push] token refreshed');
    });

    currentToken = await messaging.getToken();
    if (currentToken != null) {
      _tokenController.add(currentToken!);
      debugPrint('[Push] initial token: ${currentToken!.substring(0, 12)}…');
    }
  }
}
