import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';

/// Mlango wa huduma (ServiceLock) - kama mtumiaji hajajiunga na huduma hiyo,
/// anaona ujumbe + kitufe cha kujiunga badala ya maudhui ya huduma.
/// Mfano: VICOBA, ROSCA, P2P.
class ServiceLock extends StatefulWidget {
  final String serviceKey;
  final String serviceName;
  final Widget child;
  const ServiceLock({
    super.key,
    required this.serviceKey,
    required this.serviceName,
    required this.child,
  });

  @override
  State<ServiceLock> createState() => _ServiceLockState();
}

class _ServiceLockState extends State<ServiceLock> {
  final List<String> _active = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final api = AppState.instance.api;
    try {
      final data = await api.get('/services/catalog');
      final act = (data['catalog'] as List)
          .where((c) => c['active'] == true)
          .map((c) => c['key'] as String)
          .toList();
      setState(() {
        _active
          ..clear()
          ..addAll(act);
        _loading = false;
      });
    } catch (_) {
      setState(() => _loading = false);
    }
  }

  Future<void> _subscribe() async {
    final api = AppState.instance.api;
    try {
      await api.post('/services/subscribe', {'serviceKey': widget.serviceKey});
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Umejiunga na huduma hiyo. Karibu!')),
      );
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Hitilafu. Jaribu tena.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    final subscribed = _active.contains(widget.serviceKey);
    if (!subscribed) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const Icon(Icons.lock_outline, size: 56, color: Colors.orange),
              const SizedBox(height: 12),
              Text(
                'Hujajiunga na huduma ya ${widget.serviceName}',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 8),
              const Text(
                'Jiunge kwanza ili kutumia huduma hii.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _subscribe,
                icon: const Icon(Icons.add),
                label: const Text('Jiunge sasa'),
              ),
            ],
          ),
        ),
      );
    }
    return widget.child;
  }
}
