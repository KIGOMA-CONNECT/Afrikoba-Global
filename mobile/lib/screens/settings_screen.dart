import 'package:flutter/material.dart';
import '../core/app_state.dart';
import 'login_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  Map<String, dynamic>? _prefs;
  Map<String, dynamic>? _user;
  List<Map<String, dynamic>> _currencies = [];
  String _currency = 'TZS';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final api = AppState.instance.api;
      final user = await AppState.instance.session.user();
      final prefsR = await api.get('/notifications/preferences');
      final currR = await api.get('/currency/my-currency');
      final currList = await api.get('/currency/currencies');
      if (mounted) {
        setState(() {
          _user = user;
          _prefs = prefsR['preferences'];
          _currency = currR['currency'] ?? 'TZS';
          _currencies = (currList['currencies'] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _updatePref(String key, bool value) async {
    try {
      final r = await AppState.instance.api.put('/notifications/preferences', {key: value});
      setState(() => _prefs = r['preferences']);
    } catch (_) {}
  }

  Future<void> _updateCurrency() async {
    try {
      await AppState.instance.api.put('/currency/my-currency', {'currency': _currency});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Sarafu imewekwa: $_currency')),
        );
      }
    } catch (_) {}
  }

  Future<void> _logout() async {
    await AppState.instance.session.clear();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Mipangilio', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 16),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Wasifu', style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                ListTile(
                  leading: const CircleAvatar(child: Icon(Icons.person)),
                  title: Text(_user?['full_name'] ?? ''),
                  subtitle: Text('${_user?['phone_number'] ?? ''} · ${_user?['role'] ?? ''}'),
                  dense: true,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Sarafu', style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                DropdownButtonFormField<String>(
                  initialValue: _currency,
                  items: _currencies.map<DropdownMenuItem<String>>((c) => DropdownMenuItem<String>(
                    value: c['code'] as String,
                    child: Text('${c['code']} - ${c['name']}'),
                  )).toList(),
                  onChanged: (v) => setState(() => _currency = v ?? _currency),
                  decoration: const InputDecoration(isDense: true),
                ),
                const SizedBox(height: 8),
                FilledButton(onPressed: _updateCurrency, child: const Text('Badilisha Sarafu')),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        if (_prefs != null)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Arifa', style: TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 8),
                  SwitchListTile(title: const Text('SMS'), value: _prefs!['sms_enabled'] ?? true, onChanged: (v) => _updatePref('sms_enabled', v), dense: true),
                  SwitchListTile(title: const Text('Miamala'), value: _prefs!['transaction_alerts'] ?? true, onChanged: (v) => _updatePref('transaction_alerts', v), dense: true),
                  SwitchListTile(title: const Text('VICOBA'), value: _prefs!['vicoba_alerts'] ?? true, onChanged: (v) => _updatePref('vicoba_alerts', v), dense: true),
                  SwitchListTile(title: const Text('ROSCA'), value: _prefs!['rosca_alerts'] ?? true, onChanged: (v) => _updatePref('rosca_alerts', v), dense: true),
                  SwitchListTile(title: const Text('P2P'), value: _prefs!['p2p_alerts'] ?? true, onChanged: (v) => _updatePref('p2p_alerts', v), dense: true),
                  SwitchListTile(title: const Text('Matangazo'), value: _prefs!['promo_alerts'] ?? false, onChanged: (v) => _updatePref('promo_alerts', v), dense: true),
                ],
              ),
            ),
          ),
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            leading: const Icon(Icons.logout, color: Colors.red),
            title: const Text('Ondoka (Logout)', style: TextStyle(color: Colors.red)),
            onTap: _logout,
          ),
        ),
      ],
    );
  }
}
