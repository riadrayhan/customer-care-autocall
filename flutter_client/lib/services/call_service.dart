/// CallService — handles Socket.io + WebRTC for receiving auto-calls.
///
/// Flow:
///   1. connect()           → opens socket, registers user
///   2. server emits incoming_call → onIncomingCall callback fires
///   3. acceptCall(callId)  → emits call_answer, waits for offer
///   4. server relays admin's webrtc_offer → we createAnswer & send back
///   5. ICE candidates exchanged both ways → audio plays automatically
///   6. endCall() / server call_ended       → cleanup

import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:permission_handler/permission_handler.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;
import 'callkit_helper.dart';
import 'push_handler.dart';

class IncomingCall {
  final String callId;
  final String callerName;
  final String message;
  final int retryCount;
  IncomingCall({
    required this.callId,
    required this.callerName,
    required this.message,
    required this.retryCount,
  });
  factory IncomingCall.fromJson(Map<String, dynamic> j) => IncomingCall(
        callId: j['callId'],
        callerName: j['callerName'] ?? 'Customer Support',
        message: j['message'] ?? '',
        retryCount: j['retryCount'] ?? 0,
      );
}

enum CallState { idle, ringing, connecting, active, ended }

class CallService extends ChangeNotifier {
  final String serverUrl;
  final String userId;

  IO.Socket? _socket;
  RTCPeerConnection? _pc;
  MediaStream?
      _localStream; // we don't send audio (one-way), but we keep API ready
  MediaStream? _remoteStream;
  RTCVideoRenderer?
      _remoteRenderer; // not used for audio-only, but kept for future video

  CallState state = CallState.idle;
  IncomingCall? currentCall;
  String? lastError;

  List<Map<String, dynamic>> iceServers = [];

  StreamSubscription? _callKitSub;
  StreamSubscription? _tokenSub;

  CallService({required this.serverUrl, required this.userId});

  bool get connected => _socket?.connected ?? false;

  // ─── Public API ───────────────────────────────────────────────────────────

  Future<void> connect() async {
    await _loadIceServers();
    await Permission.microphone.request();
    await Permission.notification.request();

    _listenToCallKit();

    _socket = IO.io(
        serverUrl,
        IO.OptionBuilder()
            .setTransports(['websocket'])
            .enableReconnection()
            .setReconnectionDelay(2000)
            .build());

    _socket!.onConnect((_) {
      debugPrint('[Socket] connected: ${_socket!.id}');
      _socket!.emit('register_user', {'userId': userId});
      _registerFcmToken();
    });

    _socket!
        .on('registered', (_) => debugPrint('[Socket] registered as $userId'));

    _socket!.on('incoming_call', (data) {
      currentCall = IncomingCall.fromJson(Map<String, dynamic>.from(data));
      state = CallState.ringing;
      lastError = null;
      // Show native incoming-call UI (ringtone + lockscreen).
      CallKitHelper.showIncoming(
        callId: currentCall!.callId,
        callerName: currentCall!.callerName,
      );
      notifyListeners();
    });

    _socket!.on('call_cancelled', (_) {
      _resetState();
    });

    _socket!.on('call_ended', (_) {
      _resetState();
    });

    _socket!.on('webrtc_offer', (data) async {
      await _handleOffer(data);
    });

    _socket!.on('ice_candidate', (data) async {
      if (_pc == null || data['candidate'] == null) return;
      final c = data['candidate'];
      try {
        await _pc!.addCandidate(RTCIceCandidate(
          c['candidate'],
          c['sdpMid'],
          c['sdpMLineIndex'],
        ));
      } catch (e) {
        debugPrint('[ICE] add failed: $e');
      }
    });

    _socket!.on('ice_restart', (_) async {
      if (_pc == null) return;
      // Wait for fresh offer from admin side
      debugPrint('[WebRTC] ICE restart requested');
    });

    _socket!.on('error_event', (d) {
      lastError = d['error']?.toString();
      notifyListeners();
    });

    _socket!.onDisconnect((_) => debugPrint('[Socket] disconnected'));
    _socket!.connect();
  }

  Future<void> acceptCall() async {
    if (currentCall == null) return;
    if (state != CallState.ringing) {
      debugPrint('[Call] acceptCall ignored, state=$state');
      return;
    }
    state = CallState.connecting;
    notifyListeners();

    await _createPeerConnection();
    _socket!.emit('call_answer', {'callId': currentCall!.callId});
    debugPrint('[Call] call_answer emitted for ${currentCall!.callId}');
  }

  void rejectCall() {
    if (currentCall == null) return;
    _socket!.emit('call_reject', {'callId': currentCall!.callId});
    _resetState();
  }

  void endCall() {
    if (currentCall == null) return;
    _socket!.emit('end_call', {
      'callId': currentCall!.callId,
      'reason': 'user_ended',
    });
    _resetState();
  }

  Future<void> disconnect() async {
    await _cleanupRtc();
    await _callKitSub?.cancel();
    _callKitSub = null;
    await _tokenSub?.cancel();
    _tokenSub = null;
    await CallKitHelper.endAll();
    _socket?.disconnect();
    _socket?.dispose();
    _socket = null;
  }

  // ─── FCM token bridge ─────────────────────────────────────────────────────

  void _registerFcmToken() {
    final tok = PushHandler.currentToken;
    if (tok != null && _socket != null) {
      _socket!.emit('register_fcm_token', {'userId': userId, 'token': tok});
      debugPrint('[FCM] token registered with server');
    }
    // Re-register on refresh
    _tokenSub?.cancel();
    _tokenSub = PushHandler.tokenStream.listen((t) {
      if (_socket?.connected ?? false) {
        _socket!.emit('register_fcm_token', {'userId': userId, 'token': t});
      }
    });
  }

  // ─── CallKit event bridge ─────────────────────────────────────────────────

  void _listenToCallKit() {
    _callKitSub?.cancel();
    _callKitSub = CallKitHelper.events.listen((event) {
      if (event == null) return;
      switch (event.event) {
        case Event.actionCallAccept:
          // User tapped Accept on the native screen.
          if (state == CallState.ringing) acceptCall();
          break;
        case Event.actionCallDecline:
          if (state == CallState.ringing) rejectCall();
          break;
        case Event.actionCallEnded:
        case Event.actionCallTimeout:
          if (state == CallState.active || state == CallState.connecting) {
            endCall();
          } else if (state == CallState.ringing) {
            rejectCall();
          }
          break;
        default:
          break;
      }
    });
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  Future<void> _loadIceServers() async {
    try {
      final r = await http.get(Uri.parse('$serverUrl/api/ice-servers'));
      final j = jsonDecode(r.body);
      iceServers = List<Map<String, dynamic>>.from(j['iceServers']);
    } catch (e) {
      debugPrint('[ICE] fetch failed, using fallback: $e');
      iceServers = [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
      ];
    }
  }

  Future<void> _createPeerConnection() async {
    final config = {
      'iceServers': iceServers,
      'sdpSemantics': 'unified-plan',
    };
    _pc = await createPeerConnection(config);

    // Configure audio session BEFORE adding tracks so playback routes correctly.
    await _configureAudioSession();

    // Add a local audio track (so PeerConnection negotiates audio); user can speak back too.
    _localStream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': false,
    });
    for (final t in _localStream!.getAudioTracks()) {
      await _pc!.addTrack(t, _localStream!);
    }

    _pc!.onTrack = (RTCTrackEvent e) {
      if (e.streams.isNotEmpty) {
        _remoteStream = e.streams[0];
        // Ensure remote audio tracks are enabled & route to loud speaker so
        // the user actually hears the admin / TTS voice.
        for (final t in _remoteStream!.getAudioTracks()) {
          try {
            t.enabled = true;
          } catch (_) {}
        }
        _enableSpeakerphone();
        debugPrint('[WebRTC] Remote audio track received & routed to speaker');
      }
    };

    _pc!.onIceCandidate = (RTCIceCandidate c) {
      if (c.candidate == null || currentCall == null) return;
      debugPrint(
          '[ICE] local candidate: ${c.candidate?.substring(0, c.candidate!.length > 60 ? 60 : c.candidate!.length)}');
      _socket!.emit('ice_candidate', {
        'callId': currentCall!.callId,
        'candidate': {
          'candidate': c.candidate,
          'sdpMid': c.sdpMid,
          'sdpMLineIndex': c.sdpMLineIndex,
        },
      });
    };

    _pc!.onIceConnectionState = (s) {
      debugPrint('[ICE] connection state: $s');
    };
    _pc!.onIceGatheringState = (s) {
      debugPrint('[ICE] gathering state: $s');
    };
    _pc!.onSignalingState = (s) {
      debugPrint('[Signaling] state: $s');
    };

    _pc!.onConnectionState = (RTCPeerConnectionState s) {
      debugPrint('[WebRTC] PC state: $s');
      if (s == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        state = CallState.active;
        notifyListeners();
      } else if (s == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _socket?.emit('ice_restart', {'callId': currentCall?.callId});
      }
    };
  }

  Future<void> _handleOffer(dynamic data) async {
    if (_pc == null) return;
    final sdp = data['sdp'];
    await _pc!.setRemoteDescription(
      RTCSessionDescription(sdp['sdp'], sdp['type']),
    );
    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);
    _socket!.emit('webrtc_answer', {
      'callId': currentCall!.callId,
      'sdp': {'sdp': answer.sdp, 'type': answer.type},
    });
    debugPrint('[WebRTC] Answer sent');
  }

  /// Set up the OS audio mode for a voice call (full-duplex, AEC on, loud
  /// speaker route) so the remote audio is audible.
  Future<void> _configureAudioSession() async {
    try {
      // Android: switch to communication mode so WebRTC audio uses the
      // VOICE_CALL stream (loud, full duplex, with AEC).
      await Helper.setAndroidAudioConfiguration(
        AndroidAudioConfiguration(
          manageAudioFocus: true,
          androidAudioMode: AndroidAudioMode.inCommunication,
          androidAudioFocusMode: AndroidAudioFocusMode.gain,
          androidAudioStreamType: AndroidAudioStreamType.voiceCall,
          androidAudioAttributesUsageType:
              AndroidAudioAttributesUsageType.voiceCommunication,
          androidAudioAttributesContentType:
              AndroidAudioAttributesContentType.speech,
        ),
      );
    } catch (e) {
      debugPrint('[Audio] setAndroidAudioConfiguration failed: $e');
    }
    try {
      await Helper.setSpeakerphoneOn(true);
    } catch (e) {
      debugPrint('[Audio] setSpeakerphoneOn failed: $e');
    }
  }

  Future<void> _enableSpeakerphone() async {
    try {
      await Helper.setSpeakerphoneOn(true);
    } catch (e) {
      debugPrint('[Audio] enable speakerphone failed: $e');
    }
  }

  Future<void> _cleanupRtc() async {
    try {
      _localStream?.getTracks().forEach((t) => t.stop());
      await _localStream?.dispose();
      _localStream = null;
      await _remoteStream?.dispose();
      _remoteStream = null;
      await _pc?.close();
      _pc = null;
    } catch (_) {}
  }

  void _resetState() async {
    final id = currentCall?.callId;
    await _cleanupRtc();
    if (id != null) await CallKitHelper.endCall(id);
    currentCall = null;
    state = CallState.idle;
    notifyListeners();
  }
}
