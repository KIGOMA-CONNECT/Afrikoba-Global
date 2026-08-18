import 'dart:convert';

import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

/// Admin Panel - takwimu za mfumo, watumiaji, miamala, uendeshaji wa miradi.
/// Huonekana tu kwa watumiaji wenye role ADMIN.
class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key});

  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  Map<String, dynamic>? _stats;
  List<Map<String, dynamic>> _users = [];
  List<Map<String, dynamic>> _txs = [];
  bool _loading = true;
  bool _isAdmin = false;

  final _projectIdCtrl = TextEditingController();
  final _revenueAmtCtrl = TextEditingController();
  final _revenueDescCtrl = TextEditingController();
  final _milestonesCtrl = TextEditingController();
  final _milestoneIdCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  @override
  void dispose() {
    _projectIdCtrl.dispose();
    _revenueAmtCtrl.dispose();
    _revenueDescCtrl.dispose();
    _milestonesCtrl.dispose();
    _milestoneIdCtrl.dispose();
    super.dispose();
  }

  Future<void> _bootstrap() async {
    final me = await AppState.instance.session.user();
    final admin = me?['role'] == 'ADMIN';
    if (!admin) {
      if (mounted) setState(() => _loading = false);
      return;
    }
    setState(() => _isAdmin = true);
    await _load();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    try {
      final stats = await api.get('/admin/dashboard');
      final users = await api.get('/admin/users');
      final txs = await api.get('/admin/transactions?limit=50');
      if (mounted) {
        setState(() {
          _stats = stats['stats'] as Map<String, dynamic>;
          _users = (users['users'] as List).cast<Map<String, dynamic>>();
          _txs = (txs['transactions'] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String msg, {bool ok = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: ok ? Colors.green : Colors.red),
    );
  }

  int? get _projectId => int.tryParse(_projectIdCtrl.text.trim());

  Future<void> _recordRevenue() async {
    final pid = _projectId;
    if (pid == null || _revenueAmtCtrl.text.trim().isEmpty) {
      _toast('Weka Project ID na kiasi.', ok: false);
      return;
    }
    try {
      await AppState.instance.api.post('/admin/projects/$pid/revenue', {
        'amount': double.parse(_revenueAmtCtrl.text.trim()),
        'description': _revenueDescCtrl.text.trim(),
      });
      _toast('Mapato yameingizwa.');
      _revenueAmtCtrl.clear();
      _revenueDescCtrl.clear();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    }
  }

  Future<void> _createMilestones() async {
    final pid = _projectId;
    if (pid == null || _milestonesCtrl.text.trim().isEmpty) {
      _toast('Weka Project ID na milestones (JSON).', ok: false);
      return;
    }
    try {
      final milestones = jsonDecode(_milestonesCtrl.text.trim());
      await AppState.instance.api.post('/admin/projects/$pid/milestones', {'milestones': milestones});
      _toast('Milestones zimeundwa.');
      _milestonesCtrl.clear();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('JSON sio sahihi.', ok: false);
    }
  }

  Future<void> _releaseMilestone() async {
    final mid = int.tryParse(_milestoneIdCtrl.text.trim());
    if (mid == null) {
      _toast('Weka Milestone ID.', ok: false);
      return;
    }
    try {
      await AppState.instance.api.post('/admin/milestones/$mid/release', {});
      _toast('Milestone imetolewa (funds released).');
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (!_isAdmin) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('Sehemu hii ni ya Admin pekee.',
              style: TextStyle(fontSize: 15, color: Colors.grey)),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Admin Panel', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
          const SizedBox(height: 12),
          _statsGrid(),
          const SizedBox(height: 12),
          _projectOpsCard(),
          const SizedBox(height: 12),
          _usersCard(),
          const SizedBox(height: 12),
          _txsCard(),
        ],
      ),
    );
  }

  Widget _statsGrid() {
    final s = _stats ?? <String, dynamic>{};
    final rev = (s['revenue'] as Map<String, dynamic>?) ?? {};
    final items = [
      ('Watumiaji', '${s['users'] ?? 0}'),
      ('Miamala', '${(s['transactions'] as Map?)?.isEmpty == false ? (s['transactions'] as Map)['total'] : 0}'),
      ('Pools', '${s['roscaPools'] ?? 0}'),
      ('Miradi', '${s['projects'] ?? 0}'),
      ('VICOBA', '${s['vicobaGroups'] ?? 0}'),
      ('Mapato', formatMoney(rev['total_commission'] ?? 0)),
    ];
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      childAspectRatio: 2.4,
      mainAxisSpacing: 8,
      crossAxisSpacing: 8,
      children: [
        for (final (label, value) in items)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(label, style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                  const SizedBox(height: 2),
                  Text(value,
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _projectOpsCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Uendeshaji wa Miradi', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            TextField(
              controller: _projectIdCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Project ID'),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _revenueAmtCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Mapato (TZS)', prefixText: 'TZS '),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _revenueDescCtrl,
                    decoration: const InputDecoration(labelText: 'Maelezo'),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _recordRevenue, child: const Text('Ingiza Mapato')),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _milestonesCtrl,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Milestones (JSON array)',
                hintText: '[{"milestoneName":"Hatua 1","amount":500000,"description":"..."}]',
              ),
            ),
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(onPressed: _createMilestones, child: const Text('Unda Milestones')),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _milestoneIdCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Milestone ID'),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _releaseMilestone, child: const Text('Toa Milestone')),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _usersCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Watumiaji', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            for (final u in _users)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text('${u['full_name']} (${u['phone_number']})',
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                subtitle: Text('${u['role']} · KYC L${u['kyc_level']} · ${u['is_active'] == true ? 'Active' : 'Inactive'}'),
                trailing: Text(formatMoney(u['wallet_balance'] ?? 0),
                    style: const TextStyle(fontWeight: FontWeight.w700)),
              ),
          ],
        ),
      ),
    );
  }

  Widget _txsCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Miamala (50 hivi karibuni)',
                style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            for (final t in _txs)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.receipt_long_outlined),
                title: Text('${t['reference_id']}',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                subtitle: Text('${t['full_name']} · ${t['type']}'),
                trailing: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(formatMoney(t['total_charged'] ?? t['wallet_amount'] ?? 0),
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 12)),
                    StatusBadge('${t['status']}'),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
