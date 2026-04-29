import 'package:flutter/material.dart';
import '../services/call_service.dart';

class IncomingCallScreen extends StatefulWidget {
  final CallService service;
  const IncomingCallScreen({super.key, required this.service});

  @override
  State<IncomingCallScreen> createState() => _IncomingCallScreenState();
}

class _IncomingCallScreenState extends State<IncomingCallScreen> {
  @override
  void initState() {
    super.initState();
    widget.service.addListener(_onChange);
  }

  void _onChange() {
    if (!mounted) return;
    final s = widget.service.state;
    if (s == CallState.idle || s == CallState.ended) {
      // Schedule pop after frame; route may be unmounted already.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        if (Navigator.of(context).canPop()) {
          Navigator.of(context).pop();
        }
      });
    }
    setState(() {});
  }

  @override
  void dispose() {
    widget.service.removeListener(_onChange);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.service;
    final call = s.currentCall;
    if (call == null) return const SizedBox();

    final ringing = s.state == CallState.ringing;
    final active = s.state == CallState.active;

    return Scaffold(
      backgroundColor: const Color(0xFF0f172a),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            children: [
              const Spacer(),
              Container(
                width: 140,
                height: 140,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: Colors.blue.withOpacity(.2),
                  border: Border.all(color: Colors.blue, width: 3),
                ),
                child: const Icon(Icons.support_agent,
                    size: 80, color: Colors.blue),
              ),
              const SizedBox(height: 24),
              Text(
                call.callerName,
                style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.bold,
                    color: Colors.white),
              ),
              const SizedBox(height: 8),
              Text(
                ringing
                    ? 'Incoming call…'
                    : active
                        ? 'Connected'
                        : 'Connecting…',
                style: TextStyle(fontSize: 16, color: Colors.grey[400]),
              ),
              const SizedBox(height: 32),
              if (call.message.isNotEmpty)
                Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Colors.white.withOpacity(.05),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    '"${call.message}"',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                        color: Colors.white70, fontStyle: FontStyle.italic),
                  ),
                ),
              const Spacer(),
              if (ringing)
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                  children: [
                    _circleBtn(Icons.call_end, Colors.red, 'Reject', () {
                      s.rejectCall();
                    }),
                    _circleBtn(Icons.call, Colors.green, 'Accept', () {
                      s.acceptCall();
                    }),
                  ],
                ),
              if (active)
                _circleBtn(Icons.call_end, Colors.red, 'End', () {
                  s.endCall();
                }),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }

  Widget _circleBtn(
      IconData icon, Color color, String label, VoidCallback onTap) {
    return Column(
      children: [
        InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: Container(
            width: 72,
            height: 72,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            child: Icon(icon, color: Colors.white, size: 32),
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: const TextStyle(color: Colors.white70)),
      ],
    );
  }
}
