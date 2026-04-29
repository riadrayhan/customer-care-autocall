/// callkit_helper.dart
/// Shows native incoming-call UI (full-screen on lockscreen, ringtone, vibration)
/// using flutter_callkit_incoming. Works on both Android and iOS (CallKit).
library;

import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';

class CallKitHelper {
  /// Show the native incoming-call screen. Returns the same callId for tracking.
  static Future<void> showIncoming({
    required String callId,
    required String callerName,
    String? handle,
  }) async {
    final params = CallKitParams(
      id: callId,
      nameCaller: callerName,
      appName: 'AutoCall',
      handle: handle ?? 'Customer Support',
      type: 0, // 0 = audio, 1 = video
      duration: 30000,
      textAccept: 'Accept',
      textDecline: 'Decline',
      missedCallNotification: const NotificationParams(
        showNotification: true,
        isShowCallback: false,
        subtitle: 'Missed call',
      ),
      android: const AndroidParams(
        isCustomNotification: true,
        isShowLogo: false,
        ringtonePath: 'system_ringtone_default',
        backgroundColor: '#0f172a',
        actionColor: '#4ade80',
        incomingCallNotificationChannelName: 'Incoming Calls',
      ),
      ios: const IOSParams(
        iconName: 'CallKitLogo',
        handleType: 'generic',
        supportsVideo: false,
        maximumCallGroups: 1,
        maximumCallsPerCallGroup: 1,
        audioSessionMode: 'default',
        audioSessionActive: true,
        audioSessionPreferredSampleRate: 44100.0,
        audioSessionPreferredIOBufferDuration: 0.005,
        supportsDTMF: false,
        supportsHolding: false,
        supportsGrouping: false,
        supportsUngrouping: false,
        ringtonePath: 'system_ringtone_default',
      ),
    );
    await FlutterCallkitIncoming.showCallkitIncoming(params);
  }

  static Future<void> endCall(String callId) async {
    await FlutterCallkitIncoming.endCall(callId);
  }

  static Future<void> endAll() async {
    await FlutterCallkitIncoming.endAllCalls();
  }

  /// Stream of CallKit events: accept / decline / timeout / ended.
  static Stream<CallEvent?> get events => FlutterCallkitIncoming.onEvent;
}
