import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/call_service.dart';
import 'incoming_call_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _serverCtrl = TextEditingController(
    text:
        'http://192.168.68.96:3000', // PC LAN IP — change to Render URL for prod
  );
  final _userIdCtrl = TextEditingController(text: 'user-001');
  CallService? _service;
  bool _connecting = false;

  @override
  void initState() {
    super.initState();
    _loadPrefs();
  }

  Future<void> _loadPrefs() async {
    final p = await SharedPreferences.getInstance();
    setState(() {
      _serverCtrl.text = p.getString('server') ?? _serverCtrl.text;
      _userIdCtrl.text = p.getString('userId') ?? _userIdCtrl.text;
    });
  }

  Future<void> _savePrefs() async {
    final p = await SharedPreferences.getInstance();
    await p.setString('server', _serverCtrl.text.trim());
    await p.setString('userId', _userIdCtrl.text.trim());
  }

  Future<void> _connect() async {
    setState(() => _connecting = true);
    await _savePrefs();
    final s = CallService(
      serverUrl: _serverCtrl.text.trim(),
      userId: _userIdCtrl.text.trim(),
    );
    await s.connect();
    s.addListener(_onCallStateChanged);
    setState(() {
      _service = s;
      _connecting = false;
    });
  }

  void _onCallStateChanged() {
    final s = _service!;
    // Push the in-app call screen as soon as the call enters ringing,
    // connecting, or active state. This guarantees the user sees a UI even
    // if CallKit's native popup is suppressed (some Android OEMs block
    // full-screen intents while the app is foregrounded).
    final inCall = s.state == CallState.ringing ||
        s.state == CallState.connecting ||
        s.state == CallState.active;
    if (inCall &&
        s.currentCall != null &&
        ModalRoute.of(context)?.settings.name != '/in-call') {
      Navigator.of(context).push(MaterialPageRoute(
        settings: const RouteSettings(name: '/in-call'),
        builder: (_) => IncomingCallScreen(service: s),
      ));
    }
    setState(() {});
  }

  Future<void> _disconnect() async {
    _service?.removeListener(_onCallStateChanged);
    await _service?.disconnect();
    setState(() => _service = null);
  }

  @override
  void dispose() {
    _service?.removeListener(_onCallStateChanged);
    _service?.disconnect();
    _serverCtrl.dispose();
    _userIdCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('AutoCall Client')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.support_agent, size: 80, color: Colors.blue),
            const SizedBox(height: 12),
            const Center(
              child: Text(
                'Customer Support Auto-Call',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(height: 32),
            TextField(
              controller: _serverCtrl,
              enabled: _service == null,
              decoration: const InputDecoration(
                labelText: 'Server URL',
                border: OutlineInputBorder(),
                helperText:
                    'e.g. http://10.0.2.2:3000 or https://...onrender.com',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _userIdCtrl,
              enabled: _service == null,
              decoration: const InputDecoration(
                labelText: 'User ID',
                border: OutlineInputBorder(),
                helperText: 'Your registered customer ID (e.g. user-001)',
              ),
            ),
            const SizedBox(height: 24),
            if (_service == null)
              FilledButton.icon(
                onPressed: _connecting ? null : _connect,
                icon: const Icon(Icons.power_settings_new),
                label: Text(_connecting ? 'Connecting…' : 'Connect & Listen'),
              )
            else
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: Colors.red),
                onPressed: _disconnect,
                icon: const Icon(Icons.power_off),
                label: const Text('Disconnect'),
              ),
            const SizedBox(height: 24),
            if (_service != null)
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.green.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.green),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle, color: Colors.green),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        'Listening for calls as ${_userIdCtrl.text}',
                        style: const TextStyle(fontWeight: FontWeight.w500),
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
