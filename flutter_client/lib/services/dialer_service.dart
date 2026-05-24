import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:socket_io_client/socket_io_client.dart' as IO;

/// Dialer-mode service. Runs on an Android phone that owns the SIM.
///
/// Flow:
///   1. Connects to backend via Socket.io and registers as a "dialer".
///   2. Waits for `sim_dial { jobId, phoneNumber }` events.
///   3. Uses native MethodChannel to place a real cellular call via
///      `Intent.ACTION_CALL`. The SIM's balance is what gets consumed.
///   4. Listens to Android `TelephonyManager` phone-state changes and
///      reports them back to the server as `sim_call_state`:
///        idle → ringing → offhook → idle
///      mapped to: dialing → ringing → connected → ended
class DialerService extends ChangeNotifier {
  DialerService({required this.serverUrl, this.dialerId, this.dialerName});

  static const _method = MethodChannel('autocall/sim_dialer');
  static const _events = EventChannel('autocall/sim_dialer_events');

  final String serverUrl;
  final String? dialerId;
  final String? dialerName;

  IO.Socket? _socket;
  StreamSubscription? _phoneSub;

  // Current SIM-dial job state.
  String? activeJobId;
  String? activePhone;
  String _phoneState = 'idle'; // idle | ringing | offhook
  String _callPhase = 'idle'; // idle | dialing | connected | ended
  bool _connected = false;
  bool _registered = false;
  bool _hasPermissions = false;
  String? lastError;

  // Stats
  int dispatched = 0;
  int completed = 0;
  int failed = 0;
  final List<Map<String, dynamic>> recent = [];

  bool get isConnected => _connected;
  bool get isRegistered => _registered;
  bool get hasPermissions => _hasPermissions;
  String get phoneState => _phoneState;
  String get callPhase => _callPhase;
  String get effectiveDialerId =>
      dialerId ?? 'dialer-${_socket?.id ?? "unknown"}';

  // ── Lifecycle ───────────────────────────────────────────────────────────

  Future<bool> ensurePermissions() async {
    final phone = await Permission.phone.request();
    // permission_handler's `phone` covers CALL_PHONE + READ_PHONE_STATE on Android.
    _hasPermissions = phone.isGranted;
    notifyListeners();
    return _hasPermissions;
  }

  Future<void> connect() async {
    await ensurePermissions();

    // Start native phone-state listener.
    try {
      await _method.invokeMethod('startListening');
    } catch (e) {
      lastError = 'startListening: $e';
    }
    _phoneSub = _events
        .receiveBroadcastStream()
        .listen(_onNativeEvent, onError: (e) => lastError = 'phone-event: $e');

    _socket = IO.io(
        serverUrl,
        IO.OptionBuilder()
            .setTransports(['websocket'])
            .enableReconnection()
            .build());

    _socket!.on('connect', (_) {
      _connected = true;
      notifyListeners();
      _socket!.emit('register_dialer', {
        if (dialerId != null) 'dialerId': dialerId,
        if (dialerName != null) 'name': dialerName,
      });
    });

    _socket!.on('dialer_registered', (data) {
      _registered = true;
      // Tell backend we start out idle.
      _socket!.emit('dialer_state', {'state': 'idle'});
      notifyListeners();
    });

    _socket!.on('sim_dial', (data) async {
      final jobId = data is Map ? data['jobId']?.toString() : null;
      final phone = data is Map ? data['phoneNumber']?.toString() : null;
      if (jobId == null || phone == null) return;
      await _handleDial(jobId, phone);
    });

    _socket!.on('sim_dial_cancel', (data) {
      final jobId = data is Map ? data['jobId']?.toString() : null;
      if (jobId == null) return;
      if (activeJobId == jobId) {
        _reportState('failed', error: 'cancelled');
        _resetJob();
      }
    });

    _socket!.on('disconnect', (_) {
      _connected = false;
      _registered = false;
      notifyListeners();
    });

    _socket!.connect();
  }

  Future<void> disconnect() async {
    try {
      await _method.invokeMethod('stopListening');
    } catch (_) {}
    await _phoneSub?.cancel();
    _phoneSub = null;
    _socket?.dispose();
    _socket = null;
    _connected = false;
    _registered = false;
    notifyListeners();
  }

  // ── Core dial handler ───────────────────────────────────────────────────

  Future<void> _handleDial(String jobId, String phone) async {
    if (activeJobId != null) {
      // Should not happen — server should respect dialer's busy state.
      _emit('sim_call_state', {
        'jobId': jobId,
        'state': 'failed',
        'error': 'dialer_busy',
      });
      return;
    }
    activeJobId = jobId;
    activePhone = phone;
    _callPhase = 'dialing';
    dispatched++;
    _addRecent(jobId, phone, 'dialing');
    notifyListeners();

    // Mark busy with server so no other jobs are routed here.
    _emit('dialer_state', {'state': 'busy'});
    _reportState('dialing');

    try {
      final ok =
          await _method.invokeMethod<bool>('dial', {'phoneNumber': phone});
      if (ok != true) {
        _reportState('failed', error: 'native_dial_returned_false');
        _resetJob();
      }
    } on PlatformException catch (e) {
      _reportState('failed', error: '${e.code}:${e.message}');
      _resetJob();
    } catch (e) {
      _reportState('failed', error: e.toString());
      _resetJob();
    }
  }

  void _onNativeEvent(dynamic event) {
    if (event is! Map) return;
    final state = event['state']?.toString() ?? '';
    if (state == 'permission_missing') {
      _hasPermissions = false;
      notifyListeners();
      return;
    }
    if (state == _phoneState) return;
    final prev = _phoneState;
    _phoneState = state;

    // Only translate phone-state changes into job state if we actually have
    // an active dispatched job.
    if (activeJobId != null) {
      // dialing → offhook means call was connected (or the user picked up
      // the line on this end). For outbound, offhook fires when we initiate.
      // We treat offhook as "connected" after dialing has been reported.
      if (state == 'offhook' && _callPhase == 'dialing') {
        _callPhase = 'connected';
        _reportState('connected');
        _updateRecent(activeJobId!, 'connected');
      } else if (state == 'idle' && (prev == 'offhook' || prev == 'ringing')) {
        // Call ended.
        _callPhase = 'ended';
        _reportState('ended');
        _updateRecent(activeJobId!, 'ended');
        completed++;
        _resetJob();
      }
    } else if (state == 'idle') {
      // Tell server we are idle again.
      _emit('dialer_state', {'state': 'idle'});
    }
    notifyListeners();
  }

  void _reportState(String state, {String? error, int? duration}) {
    if (activeJobId == null) return;
    _emit('sim_call_state', {
      'jobId': activeJobId,
      'state': state,
      if (error != null) 'error': error,
      if (duration != null) 'duration': duration,
    });
  }

  void _resetJob() {
    final terminated = activeJobId;
    final wasFailed = _callPhase != 'connected' && _callPhase != 'ended';
    if (wasFailed && terminated != null) failed++;
    activeJobId = null;
    activePhone = null;
    _callPhase = 'idle';
    _emit('dialer_state', {'state': 'idle'});
    notifyListeners();
  }

  void _emit(String event, Map<String, dynamic> data) {
    final s = _socket;
    if (s == null || !_connected) return;
    s.emit(event, data);
  }

  // ── Recent activity bookkeeping ─────────────────────────────────────────
  void _addRecent(String jobId, String phone, String state) {
    recent.insert(0, {
      'jobId': jobId,
      'phone': phone,
      'state': state,
      'ts': DateTime.now().toIso8601String(),
    });
    while (recent.length > 30) {
      recent.removeLast();
    }
  }

  void _updateRecent(String jobId, String state) {
    for (final r in recent) {
      if (r['jobId'] == jobId) {
        r['state'] = state;
        break;
      }
    }
  }
}
