import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';

/// DahShabari - salio kwa mteja, takwimu za mfumo kwa ADMIN.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  Map<String, dynamic>? _balance;
  Map<String, dynamic>? _stats;
  List<Map<String, dynamic>> _services = [];
  bool _isAdmin = false;
  bool _onboarded = false;
  String? _userName;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final user = await AppState.instance.session.user();
    final isAdmin = user?['role'] == 'ADMIN';
    final onboarded = await AppState.instance.session.onboarded();
    final api = AppState.instance.api;
    try {
      if (isAdmin) {
        final s = await api.get('/admin/dashboard');
        setState(() => _stats = s['stats'] as Map<String, dynamic>);
      } else {
        final b = await api.get('/wallet/balance');
        final c = await api.get('/services/catalog');
        setState(() {
          _balance = b['balance'] as Map<String, dynamic>;
          _services = (c['catalog'] as List).cast<Map<String, dynamic>>();
        });
      }
    } catch (_) {}
    if (mounted) {
      setState(() {
        _isAdmin = isAdmin;
        _onboarded = onboarded;
        _userName = user?['full_name'] as String?;
      });
    }
  }

  Future<void> _toggleOnboard(Map<String, dynamic> svc) async {
    final active = svc['active'] == true;
    try {
      await AppState.instance.api
          .post('/services/${active ? 'unsubscribe' : 'subscribe'}', {'serviceKey': svc['key']});
      if (!mounted) return;
      final c = await AppState.instance.api.get('/services/catalog');
      setState(() => _services = (c['catalog'] as List).cast<Map<String, dynamic>>());
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: Colors.red));
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Hitilafu.'), backgroundColor: Colors.red));
    }
  }

  Future<void> _finishOnboard() async {
    await AppState.instance.session.setOnboarded();
    if (!mounted) return;
    setState(() => _onboarded = true);
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Karibu Afrikoba! Huduma zako ziko tayari.')));
  }

  bool get _needsOnboarding {
    final joinable = _services.where((s) => s['baseService'] != true && s['comingSoon'] != true).toList();
    return !_isAdmin && !_onboarded && joinable.isNotEmpty && !joinable.any((s) => s['active'] == true);
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Karibu, ${_userName ?? 'Mtumiaji'}',
              style: Theme.of(context).textTheme.headlineSmall),
          Text(_isAdmin ? 'Muhtasari wa mfumo mzima' : 'Salio na miamala yako',
              style: TextStyle(color: Colors.grey.shade600)),
          const SizedBox(height: 16),
          if (_needsOnboarding) ...[
            _onboardingCard(),
            const SizedBox(height: 16),
          ],
          if (_isAdmin && _stats != null) _adminStats(),
          if (!_isAdmin && _balance != null) _balanceCards(),
          if (!_isAdmin && _services.isNotEmpty) ...[
            const SizedBox(height: 16),
            _servicesCard(),
          ],
        ],
      ),
    );
  }

  Widget _onboardingCard() {
    final joinable = _services
        .where((s) => s['baseService'] != true && s['comingSoon'] != true)
        .toList();
    return Card(
      color: const Color(0xFFF2FAF4),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Karibu! Chagua huduma unazotaka kuanza',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 4),
            Text(
                'Washa huduma zinazokufaa. Unaweza kubadilisha wakati wowote kwenye Huduma Zako.',
                style: TextStyle(fontSize: 12.5, color: Colors.grey.shade700)),
            const SizedBox(height: 6),
            for (final svc in joinable)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.circle, size: 12, color: Color(0xFF0B7A41)),
                title: Text('${svc['swahili'] ?? svc['name']}',
                    style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${svc['tagline'] ?? ''}',
                    maxLines: 2, overflow: TextOverflow.ellipsis),
                trailing: FilledButton.tonal(
                  onPressed: () => _toggleOnboard(svc),
                  child: Text(svc['active'] == true ? 'Ondoa' : 'Jiunge'),
                ),
              ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: FilledButton(onPressed: _finishOnboard, child: const Text('Maliza kuchagua')),
            ),
          ],
        ),
      ),
    );
  }

  Widget _balanceCards() {
    return Row(
      children: [
        Expanded(
          child: _statCard(
            'Salio la Wallet',
            formatMoney(_balance?['wallet_balance']),
            Icons.account_balance_wallet,
            const Color(0xFF0B7A41),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _statCard(
            'Fedha Zilizofungwa',
            formatMoney(_balance?['locked_balance']),
            Icons.lock_outline,
            const Color(0xFF155E9C),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _statCard(
            'Sarafu',
            (_balance?['currency_code'] ?? 'TZS').toString(),
            Icons.monetization_on_outlined,
            const Color(0xFF6D3FB8),
          ),
        ),
      ],
    );
  }

  Widget _adminStats() {
    final s = _stats!;
    final rev = s['revenue'] as Map<String, dynamic>? ?? {};
    final tx = s['transactions'] as Map<String, dynamic>? ?? {};
    final totalRev = (rev['total_commission'] ?? 0) +
        (rev['total_platform_fees'] ?? 0) +
        (rev['total_maintenance_fees'] ?? 0);
    return Column(
      children: [
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          childAspectRatio: 2.4,
          children: [
            _statCard('Watumiaji', '${s['users'] ?? 0}', Icons.people, const Color(0xFF0B7A41)),
            _statCard('Miamala', '${tx['total'] ?? 0} (${tx['pending'] ?? 0} PEND)', Icons.receipt_long, const Color(0xFF155E9C)),
            _statCard('Mizunguko (ROSCA)', '${s['roscaPools'] ?? 0}', Icons.sync_alt, const Color(0xFF0E8A8A)),
            _statCard('Miradi (P2P)', '${s['projects'] ?? 0}', Icons.trending_up, const Color(0xFF6D3FB8)),
            _statCard('Vikundi vya VICOBA', '${s['vicobaGroups'] ?? 0}', Icons.groups, const Color(0xFFB26A00)),
            _statCard('Mapato ya Kampuni', formatMoney(totalRev), Icons.savings, const Color(0xFFC62828)),
          ],
        ),
      ],
    );
  }

  Widget _servicesCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Huduma Zako', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: _services.map((svc) {
                final on = svc['active'] == true;
                return Chip(
                  backgroundColor: on ? Colors.green.shade50 : Colors.grey.shade200,
                  label: Text(
                    '${svc['swahili'] ?? svc['name']} — ${on ? 'IMEWASHWA' : 'HAIJAWASHWA'}',
                    style: TextStyle(fontSize: 12, color: on ? Colors.green.shade800 : Colors.grey.shade700),
                  ),
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statCard(String label, String value, IconData icon, Color color) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(icon, color: color, size: 22),
            const SizedBox(height: 6),
            Text(value, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
            Text(label, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
          ],
        ),
      ),
    );
  }
}
