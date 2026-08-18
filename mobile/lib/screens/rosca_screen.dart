import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/service_lock.dart';
import '../widgets/status_badge.dart';

/// ROSCA - Vikoba / Vikundi vya Mzunguko wa Pesa (Group Savings).
class RoscaScreen extends StatelessWidget {
  const RoscaScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const ServiceLock(
      serviceKey: 'ROSCA',
      serviceName: 'ROSCA',
      child: _RoscaBody(),
    );
  }
}

class _RoscaBody extends StatefulWidget {
  const _RoscaBody();

  @override
  State<_RoscaBody> createState() => _RoscaBodyState();
}

class _RoscaBodyState extends State<_RoscaBody> {
  List<Map<String, dynamic>> _pools = [];
  bool _loading = true;

  final _nameCtrl = TextEditingController();
  final _amountCtrl = TextEditingController();
  final _membersCtrl = TextEditingController();
  String _cycleFreq = 'WEEKLY';
  String _poolType = 'PUBLIC';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _amountCtrl.dispose();
    _membersCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await AppState.instance.api.get('/rosca/pools');
      if (mounted) {
        setState(() {
          _pools = (res['pools'] as List).cast<Map<String, dynamic>>();
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

  Future<void> _create() async {
    try {
      await AppState.instance.api.post('/rosca/pools', {
        'poolName': _nameCtrl.text.trim(),
        'contributionAmount': double.parse(_amountCtrl.text.trim()),
        'cycleFrequency': _cycleFreq,
        'totalMembers': int.parse(_membersCtrl.text.trim()),
        'poolType': _poolType,
      });
      if (!mounted) return;
      _toast('Kikoba kimeundwa.');
      _nameCtrl.clear();
      _amountCtrl.clear();
      _membersCtrl.clear();
      Navigator.of(context).pop();
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      _toast(e.message, ok: false);
    } catch (_) {
      if (!mounted) return;
      _toast('Hitilafu.', ok: false);
    }
  }

  void _openCreate() {
    showModalBottomSheet(
      context: context,
      builder: (_) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Unda Kikoba (ROSCA Pool)',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
            const SizedBox(height: 12),
            TextField(
              controller: _nameCtrl,
              decoration: const InputDecoration(labelText: 'Jina la Kikoba'),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _amountCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Mchango wa kila mzunguko (TZS)', prefixText: 'TZS '),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: _membersCtrl,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Idadi ya Wanachama (min 3)'),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _cycleFreq,
              decoration: const InputDecoration(labelText: 'Mzunguko'),
              items: const [
                DropdownMenuItem(value: 'WEEKLY', child: Text('Kila wiki')),
                DropdownMenuItem(value: 'MONTHLY', child: Text('Kila mwezi')),
              ],
              onChanged: (v) => setState(() => _cycleFreq = v ?? 'WEEKLY'),
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              initialValue: _poolType,
              decoration: const InputDecoration(labelText: 'Aina ya Kikoba'),
              items: const [
                DropdownMenuItem(value: 'PUBLIC', child: Text('Wazi (PUBLIC)')),
                DropdownMenuItem(value: 'PRIVATE', child: Text('Faragha (PRIVATE)')),
              ],
              onChanged: (v) => setState(() => _poolType = v ?? 'PUBLIC'),
            ),
            const SizedBox(height: 14),
            FilledButton(onPressed: _create, child: const Text('Unda Kikoba')),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              const Expanded(
                child: Text('Vikoba', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
              ),
              FilledButton.icon(
                onPressed: _openCreate,
                icon: const Icon(Icons.add),
                label: const Text('Unda'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text('Mfumo wa mzunguko wa pesa: kila mwanachama hupokea zamu ya mfuko.',
              style: TextStyle(color: Colors.grey)),
          const SizedBox(height: 12),
          if (_pools.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Hakuna vikoba bado. Unda kikoba chako!', textAlign: TextAlign.center),
            ),
          for (final p in _pools) _poolCard(p),
        ],
      ),
    );
  }

  Widget _poolCard(Map<String, dynamic> p) {
    return Card(
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: const Color(0xFF0B7A41).withValues(alpha: .12),
          child: const Icon(Icons.diversity_3, color: Color(0xFF0B7A41)),
        ),
        title: Text('${p['pool_name']}'),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Mchango ${formatMoney(p['contribution_amount'])} · ${p['cycle_frequency']} · ${p['pool_type']}'),
            Text('Wanachama ${p['current_members']}/${p['total_members']} · Mzunguko #${p['current_cycle'] ?? 1}'),
          ],
        ),
        isThreeLine: true,
        trailing: StatusBadge('${p['status']}'),
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => PoolDetailScreen(poolId: p['id'] as int)),
          );
          _load();
        },
      ),
    );
  }
}

/// Maelezo ya pool - orodha ya zamu na ratiba ya malipo.
class PoolDetailScreen extends StatefulWidget {
  final int poolId;
  const PoolDetailScreen({super.key, required this.poolId});

  @override
  State<PoolDetailScreen> createState() => _PoolDetailScreenState();
}

class _PoolDetailScreenState extends State<PoolDetailScreen> {
  Map<String, dynamic>? _pool;
  bool _loading = true;
  bool _wantEarly = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await AppState.instance.api.get('/rosca/pools/${widget.poolId}');
      if (mounted) {
        setState(() {
          _pool = res['pool'] as Map<String, dynamic>;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _join() async {
    try {
      final res = await AppState.instance.api.post('/rosca/pools/${widget.poolId}/join', {
        'wantEarlySlot': _wantEarly,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${res['message']}'), backgroundColor: Colors.green),
      );
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: Colors.red));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_pool?['pool_name'] ?? 'Kikoba')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _info(),
                  const SizedBox(height: 12),
                  _joinCard(),
                  const SizedBox(height: 12),
                  _membersCard(),
                  const SizedBox(height: 12),
                  _schedulesCard(),
                ],
              ),
            ),
    );
  }

  Widget _info() {
    final p = _pool!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${p['pool_name']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
                ),
                StatusBadge('${p['status']}'),
              ],
            ),
            const SizedBox(height: 6),
            Text('Mchango: ${formatMoney(p['contribution_amount'])} kwa ${p['cycle_frequency']}'),
            Text('Wanachama: ${p['current_members']}/${p['total_members']} · Aina: ${p['pool_type']}'),
          ],
        ),
      ),
    );
  }

  Widget _joinCard() {
    final p = _pool!;
    final open = p['status'] == 'WAITING_MEMBERS' &&
        ((p['current_members'] ?? 0) < (p['total_members'] ?? 0));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Jiunge na Kikoba', style: TextStyle(fontWeight: FontWeight.w700)),
            if (open) ...[
              const SizedBox(height: 8),
              CheckboxListTile(
                value: _wantEarly,
                onChanged: (v) => setState(() => _wantEarly = v ?? false),
                title: const Text('Nataka namba ya mwanzo (1/2)'),
                subtitle: const Text('Inahitaji Trust Score ya juu na Locked Collateral'),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: _join, child: const Text('Jiunga')),
              ),
            ] else
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 6),
                child: Text('Kikoba hiki hakikubali wanachama tena.'),
              ),
          ],
        ),
      ),
    );
  }

  Widget _membersCard() {
    final members = ((_pool?['members'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Wanachama & Mpangilio wa Zamu',
                style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            for (final m in members)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: CircleAvatar(
                  radius: 16,
                  child: Text('${m['assigned_queue_number']}'),
                ),
                title: Text('${m['full_name']}'),
                subtitle: Text('${m['phone_number']} · Trust ${m['trust_score']}'),
                trailing: m['has_received_payout'] == true
                    ? const Icon(Icons.check_circle, color: Color(0xFF0B7A41))
                    : null,
              ),
          ],
        ),
      ),
    );
  }

  Widget _schedulesCard() {
    final scheds = ((_pool?['schedules'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Ratiba ya Malipo', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            for (final s in scheds)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.event),
                title: Text(
                    'Mzunguko #${s['cycle_number']} — ${formatDate(s['scheduled_date'])}'),
                subtitle: Text('Malipo ${formatMoney(s['total_payout_amount'])} · Kamishini ${formatMoney(s['comm_amount'])}'),
                trailing: StatusBadge('${s['status']}'),
              ),
          ],
        ),
      ),
    );
  }
}
