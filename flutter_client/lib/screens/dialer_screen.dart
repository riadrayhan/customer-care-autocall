import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/dialer_service.dart';

/// "Dialer Mode" — this phone (with a SIM) becomes the outbound caller.
/// The admin panel sends phone numbers to the backend, the backend routes
/// them to this device, and this device places real cellular calls.
class DialerScreen extends StatefulWidget {
  const DialerScreen({super.key});
  @override
  State<DialerScreen> createState() => _DialerScreenState();
}

class _DialerScreenState extends State<DialerScreen> {
  final _serverCtrl = TextEditingController(text: 'http://192.168.68.71:3000');
  final _idCtrl = TextEditingController(text: 'dialer-01');
  final _nameCtrl = TextEditingController(text: 'SIM Phone 01');
  DialerService? _svc;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final p = await SharedPreferences.getInstance();
    setState(() {
      _serverCtrl.text = p.getString('dialer.server') ?? _serverCtrl.text;
      _idCtrl.text = p.getString('dialer.id') ?? _idCtrl.text;
      _nameCtrl.text = p.getString('dialer.name') ?? _nameCtrl.text;
    });
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setString('dialer.server', _serverCtrl.text.trim());
    await p.setString('dialer.id', _idCtrl.text.trim());
    await p.setString('dialer.name', _nameCtrl.text.trim());
  }

  Future<void> _connect() async {
    setState(() => _busy = true);
    await _save();
    final svc = DialerService(
      serverUrl: _serverCtrl.text.trim(),
      dialerId: _idCtrl.text.trim().isEmpty ? null : _idCtrl.text.trim(),
      dialerName: _nameCtrl.text.trim().isEmpty ? null : _nameCtrl.text.trim(),
    );
    svc.addListener(_onChange);
    final granted = await svc.ensurePermissions();
    if (!granted && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
            content: Text(
          'Phone permission denied — cannot place calls. Enable it in app settings.',
        )),
      );
    }
    await svc.connect();
    if (!mounted) return;
    setState(() {
      _svc = svc;
      _busy = false;
    });
  }

  Future<void> _disconnect() async {
    _svc?.removeListener(_onChange);
    await _svc?.disconnect();
    setState(() => _svc = null);
  }

  void _onChange() => setState(() {});

  @override
  void dispose() {
    _svc?.removeListener(_onChange);
    _svc?.disconnect();
    _serverCtrl.dispose();
    _idCtrl.dispose();
    _nameCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final svc = _svc;
    return Scaffold(
      appBar: AppBar(title: const Text('SIM Dialer Mode')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _Banner(),
            const SizedBox(height: 16),
            TextField(
              controller: _serverCtrl,
              enabled: svc == null,
              decoration: const InputDecoration(
                labelText: 'Server URL',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _idCtrl,
              enabled: svc == null,
              decoration: const InputDecoration(
                labelText: 'Dialer ID',
                border: OutlineInputBorder(),
                helperText: 'Unique id for this phone (admin targets by this).',
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _nameCtrl,
              enabled: svc == null,
              decoration: const InputDecoration(
                labelText: 'Display Name',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 20),
            if (svc == null)
              FilledButton.icon(
                onPressed: _busy ? null : _connect,
                icon: const Icon(Icons.power_settings_new),
                label: Text(_busy ? 'Connecting…' : 'Start Dialer'),
              )
            else
              FilledButton.icon(
                style: FilledButton.styleFrom(backgroundColor: Colors.red),
                onPressed: _disconnect,
                icon: const Icon(Icons.stop_circle_outlined),
                label: const Text('Stop Dialer'),
              ),
            const SizedBox(height: 24),
            if (svc != null) _Status(svc: svc),
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner();
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.amber.withOpacity(0.12),
        border: Border.all(color: Colors.amber),
        borderRadius: BorderRadius.circular(8),
      ),
      child: const Row(
        children: [
          Icon(Icons.sim_card, color: Colors.amber),
          SizedBox(width: 12),
          Expanded(
            child: Text(
              'This phone will place real cellular calls. SIM balance will be '
              'consumed for each outbound call. Keep the app open and the '
              'screen unlocked for reliable dialing.',
              style: TextStyle(fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

class _Status extends StatelessWidget {
  const _Status({required this.svc});
  final DialerService svc;

  Color _color() {
    if (!svc.isConnected) return Colors.grey;
    if (!svc.isRegistered) return Colors.orange;
    if (svc.activeJobId != null) return Colors.blue;
    return Colors.green;
  }

  String _label() {
    if (!svc.isConnected) return 'Disconnected';
    if (!svc.isRegistered) return 'Connecting…';
    if (svc.activeJobId != null) {
      return 'On call (${svc.callPhase}) → ${svc.activePhone}';
    }
    return 'Idle — ready for dispatch';
  }

  @override
  Widget build(BuildContext context) {
    final color = _color();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: color.withOpacity(0.15),
            border: Border.all(color: color),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(Icons.circle, color: color, size: 14),
              const SizedBox(width: 10),
              Expanded(
                  child: Text(_label(),
                      style: const TextStyle(fontWeight: FontWeight.w600))),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            _StatChip(label: 'Dispatched', value: svc.dispatched),
            const SizedBox(width: 8),
            _StatChip(label: 'Completed', value: svc.completed),
            const SizedBox(width: 8),
            _StatChip(label: 'Failed', value: svc.failed),
          ],
        ),
        const SizedBox(height: 16),
        if (svc.recent.isNotEmpty) ...[
          const Text('Recent calls',
              style: TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          ...svc.recent.take(10).map((r) => ListTile(
                dense: true,
                leading: const Icon(Icons.phone_outlined, size: 18),
                title: Text(r['phone'] ?? ''),
                subtitle: Text(r['state'] ?? ''),
                trailing: Text((r['ts'] as String).substring(11, 19),
                    style: const TextStyle(fontSize: 11)),
              )),
        ],
        if (!svc.hasPermissions)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Text(
              'Phone permission missing — grant it in system settings.',
              style: TextStyle(color: Colors.red.shade300),
            ),
          ),
      ],
    );
  }
}

class _StatChip extends StatelessWidget {
  const _StatChip({required this.label, required this.value});
  final String label;
  final int value;
  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 10),
        decoration: BoxDecoration(
          color: Colors.white.withOpacity(0.06),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Colors.white.withOpacity(0.12)),
        ),
        child: Column(
          children: [
            Text('$value',
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.bold,
                )),
            Text(label,
                style: const TextStyle(fontSize: 11, color: Colors.white70)),
          ],
        ),
      ),
    );
  }
}
