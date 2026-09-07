import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/device_fingerprint.dart';

/// Vifaa na Sera ya Uaminifu - trusted device binding (kifaa hiki + vifaa vingine).
class DevicesScreen extends StatefulWidget {
  const DevicesScreen({super.key});

  @override
  State<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends State<DevicesScreen> {
  List<Map<String, dynamic>> _devices = [];
  String _policy = 'PERMISSIVE';
  String _fingerprint = '';
  final TextEditingController _nameCtrl = TextEditingController();
  bool _loading = true;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    _fingerprint = await afrikobaFingerprint();
    final api = AppState.instance.api;
    try {
      final d = await api.get('/devices', extraHeaders: deviceHeaders(_fingerprint));
      final me = await api.get('/auth/me');
      if (mounted) {
        setState(() {
          _devices = (d['devices'] as List).cast<Map<String, dynamic>>();
          _policy = (me['user'] as Map<String, dynamic>?)?['device_policy'] ?? 'PERMISSIVE';
          _loading = false;
        });
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _snack(e.message, error: true);
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
      _snack('Hitilafu imetokea.', error: true);
    }
  }

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message), backgroundColor: error ? Colors.red : Colors.green));
  }

  Future<void> _register() async {
    setState(() => _busy = true);
    try {
      await AppState.instance.api.post('/devices',
          {'deviceName': _nameCtrl.text.trim().isEmpty ? null : _nameCtrl.text.trim()},
          extraHeaders: deviceHeaders(_fingerprint));
      _nameCtrl.clear();
      if (!mounted) return;
      _snack('Kifaa kimesajiliwa na kuaminika.');
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _changePolicy(String policy) async {
    if (policy == _policy) return;
    setState(() => _busy = true);
    try {
      await AppState.instance.api.put('/devices/policy', {'policy': policy});
      if (!mounted) return;
      setState(() => _policy = policy);
      _snack('Sera imehifadhiwa.');
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setTrust(int id, bool trusted) async {
    try {
      await AppState.instance.api.put('/devices/$id/trust', {'trusted': trusted});
      if (!mounted) return;
      _snack(trusted ? 'Uaminifu umerejeshwa.' : 'Uaminifu umeondolewa.');
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    }
  }

  Future<void> _remove(int id) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Futa kifaa?'),
        content: const Text('Kifaa kitaondolewa kabisa kwenye akaunti yako.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(c).pop(true), child: const Text('Futa')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await AppState.instance.api.delete('/devices/$id');
      if (!mounted) return;
      _snack('Kifaa kimefutwa.');
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Vifaa na Uaminifu', style: Theme.of(context).textTheme.headlineSmall),
          Text('Dhibiti vifaa na sera ya kufunga kifaa.', style: TextStyle(color: Colors.grey.shade600)),
          const SizedBox(height: 16),
          _policyCard(),
          const SizedBox(height: 12),
          _registerCard(),
          const SizedBox(height: 12),
          Text('Vifaa Vinavyoaminika', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
          const SizedBox(height: 4),
          if (_devices.isEmpty)
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Text('Huna vifaa vya kuaminika bado.',
                    style: TextStyle(color: Colors.grey.shade600)),
              ),
            ),
          for (final d in _devices) _deviceTile(d),
        ],
      ),
    );
  }

  Widget _policyCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Sera ya Kufunga Vifaa', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(
              'TRUSTED_ONLY inazuia uhamisho na uondoaji wa hela kwenye vifaa visivyojulikana.',
              style: TextStyle(fontSize: 12.5, color: Colors.grey.shade700),
            ),
            const SizedBox(height: 10),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'PERMISSIVE', label: Text('PERMISSIVE')),
                ButtonSegment(value: 'TRUSTED_ONLY', label: Text('TRUSTED_ONLY')),
              ],
              selected: {_policy},
              onSelectionChanged: (s) => _changePolicy(s.first),
            ),
          ],
        ),
      ),
    );
  }

  Widget _registerCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Sajili Kifaa Hiki', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            TextField(
              controller: _nameCtrl,
              decoration: const InputDecoration(labelText: 'Jina la kifaa (hiari)'),
            ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: _busy ? null : _register,
              icon: const Icon(Icons.smartphone),
              label: const Text('Aminisha kifaa hiki'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _deviceTile(Map<String, dynamic> d) {
    final name = (d['device_name'] ?? 'Kifaa') as String;
    final deviceType = (d['device_type'] ?? '-') as String;
    final osBrowser = '${d['os'] ?? '-'} / ${d['browser'] ?? '-'}';
    final lastSeen = d['last_used_at'] != null ? DateTime.parse(d['last_used_at'] as String) : null;
    final trusted = d['is_trusted'] == true;
    return Card(
      child: ListTile(
        leading: Icon(trusted ? Icons.verified_user : Icons.devices_other,
            color: trusted ? const Color(0xFF0B7A41) : Colors.grey),
        title: Text(name, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text('$deviceType • $osBrowser\n'
            'Ilitumika mwisho: ${lastSeen != null ? lastSeen.toLocal().toString().substring(0, 19) : '-'}'),
        isThreeLine: true,
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (trusted)
              IconButton(
                tooltip: 'Ondoa uaminifu',
                icon: const Icon(Icons.block, color: Colors.orange),
                onPressed: () => _setTrust(d['id'] as int, false),
              )
            else
              IconButton(
                tooltip: 'Rejesha uaminifu',
                icon: const Icon(Icons.check_circle, color: Color(0xFF0B7A41)),
                onPressed: () => _setTrust(d['id'] as int, true),
              ),
            IconButton(
              tooltip: 'Futa',
              icon: const Icon(Icons.delete_outline, color: Colors.red),
              onPressed: () => _remove(d['id'] as int),
            ),
          ],
        ),
      ),
    );
  }
}