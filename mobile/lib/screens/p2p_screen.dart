import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/service_lock.dart';
import '../widgets/status_badge.dart';

/// P2P Investment - wekeza kwenye miradi ya biashara.
/// Gated: mtumiaji anahitaji kujiunga na huduma ya P2P (ServiceLock).
class P2pScreen extends StatelessWidget {
  const P2pScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const ServiceLock(
      serviceKey: 'P2P',
      serviceName: 'P2P Investment',
      child: _P2pBody(),
    );
  }
}

class _P2pBody extends StatefulWidget {
  const _P2pBody();

  @override
  State<_P2pBody> createState() => _P2pBodyState();
}

class _P2pBodyState extends State<_P2pBody> {
  List<Map<String, dynamic>> _projects = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final res = await AppState.instance.api.get('/p2p/projects');
      if (mounted) {
        setState(() {
          _projects = (res['projects'] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
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
          const Text('Miradi ya Uwekezaji',
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
          const SizedBox(height: 4),
          const Text('Wekeza katika biashara halisi na upate faida (ROI) inayolipwa kwa vipindi.',
              style: TextStyle(color: Colors.grey)),
          const SizedBox(height: 12),
          if (_projects.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Hakuna miradi kwa sasa.'),
            ),
          for (final p in _projects) _projectCard(p),
        ],
      ),
    );
  }

  Widget _projectCard(Map<String, dynamic> p) {
    final fundedPct = p['target_amount'] == null || p['target_amount'] == 0
        ? 0.0
        : ((p['raised_amount'] ?? 0) / p['target_amount'] * 100).clamp(0.0, 100.0);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${p['title']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                ),
                StatusBadge('${p['status']}'),
              ],
            ),
            const SizedBox(height: 4),
            Text('${p['sector']} · ${p['tenure_months']} miezi · Payback miezi ${p['payback_start_months']}',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            const SizedBox(height: 8),
            Text('Hisa ${formatMoney(p['share_price'])} · ROI ${p['roi_percentage']}%',
                style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text('Lengo ${formatMoney(p['target_amount'])} · Imechota ${formatMoney(p['raised_amount'] ?? 0)} · Wawekezaji ${p['investor_count'] ?? 0}',
                style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 8),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(value: fundedPct / 100, minHeight: 6),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton(
                onPressed: () async {
                  await Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => ProjectDetailScreen(projectId: p['id'] as int),
                    ),
                  );
                  _load();
                },
                child: const Text('Wekeza'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Maelezo ya mradi + uwekezaji.
class ProjectDetailScreen extends StatefulWidget {
  final int projectId;
  const ProjectDetailScreen({super.key, required this.projectId});

  @override
  State<ProjectDetailScreen> createState() => _ProjectDetailScreenState();
}

class _ProjectDetailScreenState extends State<ProjectDetailScreen> {
  Map<String, dynamic>? _project;
  bool _loading = true;
  final _sharesCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _sharesCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final res = await AppState.instance.api.get('/p2p/projects/${widget.projectId}');
      if (mounted) {
        setState(() {
          _project = res['project'] as Map<String, dynamic>;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _invest() async {
    final shares = int.parse(_sharesCtrl.text.trim());
    final price = _project?['share_price'] ?? 0;
    final total = shares * (price is num ? price.toDouble() : double.parse('$price'));
    final messenger = ScaffoldMessenger.of(context);
    try {
      final res = await AppState.instance.api
          .post('/p2p/projects/${widget.projectId}/invest', {'shares': shares});
      final txRef = res['transaction']?['reference_id'] ?? res['transactionRef'];
      messenger.showSnackBar(
        SnackBar(
          content: Text('Umeinvest TZS ${formatMoney(total)}. Ref: $txRef. Mkataba utatumwa kwa SMS.'),
          backgroundColor: Colors.green,
        ),
      );
      await _load();
    } on ApiException catch (e) {
      messenger.showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red));
    } catch (_) {
      messenger.showSnackBar(
          const SnackBar(content: Text('Hitilafu.'), backgroundColor: Colors.red));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Mradi')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _header(),
                  const SizedBox(height: 12),
                  _investCard(),
                  const SizedBox(height: 12),
                  _milestonesCard(),
                  const SizedBox(height: 12),
                  _investorsCard(),
                ],
              ),
            ),
    );
  }

  Widget _header() {
    final p = _project!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${p['title']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
                ),
                StatusBadge('${p['status']}'),
              ],
            ),
            const SizedBox(height: 6),
            Text('${p['description']}'),
            const SizedBox(height: 10),
            Text('Sector: ${p['sector']} · Hisa: ${formatMoney(p['share_price'])} · ROI: ${p['roi_percentage']}%'),
            Text('Lengo: ${formatMoney(p['target_amount'])} · Muda: ${p['tenure_months']} miezi'),
            const SizedBox(height: 6),
            Text('Business Wallet: ${formatMoney(p['businessWallet']?['business_balance'] ?? 0)}',
                style: const TextStyle(color: Color(0xFF0B7A41), fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }

  Widget _investCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Wekeza', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _sharesCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Idadi ya Hisa', prefixText: 'x '),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _invest, child: const Text('Invest')),
              ],
            ),
            const SizedBox(height: 8),
            Text('Inahitajika: Subscription ya P2P + KYC Level 2',
                style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
          ],
        ),
      ),
    );
  }

  Widget _milestonesCard() {
    final ms = ((_project?['milestones'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Escrow Milestones', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            for (final m in ms)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.flag_outlined),
                title: Text('Hatua ${m['milestone_number']}: ${m['milestone_name']}'),
                subtitle: Text('${formatMoney(m['amount'])} · ${m['status']}'),
                trailing: StatusBadge('${m['status']}'),
              ),
          ],
        ),
      ),
    );
  }

  Widget _investorsCard() {
    final invs = ((_project?['investors'] as List?) ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Wawekezaji', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            if (invs.isEmpty) const Text('Bado hakuna wawekezaji.'),
            for (final i in invs)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.person_outline),
                title: Text('${i['full_name']}'),
                subtitle: Text('Hisa ${i['shares_bought']} · ${formatMoney(i['total_amount'])}'),
                trailing: StatusBadge('${i['status']}'),
              ),
          ],
        ),
      ),
    );
  }
}
