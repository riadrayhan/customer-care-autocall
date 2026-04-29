/// push_handler.dart — STUB (Firebase disabled for now).
///
/// To enable FCM wake-up later:
///   1. Run `flutterfire configure` in this folder
///   2. Uncomment firebase_core + firebase_messaging in pubspec.yaml
///   3. Restore the FCM version of this file (see git history)
library;

import 'dart:async';
import 'package:flutter/foundation.dart';

class PushHandler {
  static String? currentToken;
  static final _tokenController = StreamController<String>.broadcast();
  static Stream<String> get tokenStream => _tokenController.stream;

  /// Safe no-op when Firebase is not configured.
  static Future<void> init() async {
    debugPrint('[Push] FCM disabled — running without wake-up push');
  }
}
