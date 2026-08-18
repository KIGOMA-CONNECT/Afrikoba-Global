import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

/// Maelezo ya kikundi cha VICOBA - wanachama, hisa, mikopo, mialiko.
class GroupDetailScreen extends StatefulWidget {
  final int groupId;
  const GroupDetailScreen({super.key, required this.groupId});

  @override
  State<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends State<GroupDetailScreen> {
  Map<String, dynamic>? _group;
  List<Map<String, dynamic>> _loans = [];
  bool _loading = true;
  bool _isLeader = false;

  final _contribCtrl = TextEditingController();
  final _sharesCtrl = TextEditingController();
  final _loanAmtCtrl = TextEditingController();
  final _inviteCtrl = TextEditingController();
  final _approveAmtCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _contribCtrl.dispose();
    _sharesCtrl.dispose();
    _loanAmtCtrl.dispose();
    _inviteCtrl.dispose();
    _approveAmtCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    try {
      final g = await api.get('/vicoba/groups/${widget.groupId}');
      final loans = await api.get('/vicoba/groups/${widget.groupId}/loans');
      final me = await AppState.instance.session.user();
      final members = (g['group']['members'] as List).cast<Map<String, dynamic>>();
      final myRole = members.firstWhere(
        (m) => m['user_id'] == me?['id'],
        orElse: () => <String, dynamic>{},
      )['role_in_group'];
      if (mounted) {
        setState(() {
          _group = g['group'] as Map<String, dynamic>;
          _loans = (loans['loans'] as List).cast<Map<String, dynamic>>();
          _isLeader = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'].contains(myRole);
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

  Future<void> _contribute() async {
    try {
      await AppState.instance.api.post('/vicoba/groups/${widget.groupId}/contribute', {
        'amount': double.parse(_contribCtrl.text),
        'sharesCount': int.parse(_sharesCtrl.text.isEmpty ? '1' : _sharesCtrl.text),
      });
      _toast('Hisa zimewekwa.');
      _contribCtrl.clear();
      _sharesCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('Hitilafu.', ok: false);
    }
  }

  Future<void> _requestLoan() async {
    final me = await AppState.instance.session.user();
    try {
      await AppState.instance.api.post('/vicoba/groups/${widget.groupId}/loans', {
        'applicantUserId': me?['id'],
        'requestedAmount': double.parse(_loanAmtCtrl.text),
      });
      _toast('Ombi la mkopo limetumwa.');
      _loanAmtCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('Hitilafu.', ok: false);
    }
  }

  Future<void> _approveLoan(int loanId) async {
    try {
      await AppState.instance.api.post('/vicoba/loans/$loanId/approve', {
        'approvedAmount': double.parse(_approveAmtCtrl.text.isEmpty ? '0' : _approveAmtCtrl.text),
      });
      _toast('Mkopo umeidhinishwa.');
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('Hitilafu.', ok: false);
    }
  }

  Future<void> _invite() async {
    final phones = _inviteCtrl.text
        .split(',')
        .map((p) => p.trim())
        .where((p) => p.isNotEmpty)
        .toList();
    if (phones.isEmpty) {
      _toast('Weka namba za simu (tenganisha kwa koma).', ok: false);
      return;
    }
    try {
      final res = await AppState.instance.api
          .post('/vicoba/groups/${widget.groupId}/invite', {'phoneNumbers': phones});
      _toast('Mialiko ${res['invited']} imetumwa.');
      _inviteCtrl.clear();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_group?['group_name'] ?? 'Kikundi')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _infoCard(),
                  const SizedBox(height: 12),
                  _membersCard(),
                  const SizedBox(height: 12),
                  _actionsCard(),
                  const SizedBox(height: 12),
                  _loansCard(),
                ],
              ),
            ),
    );
  }

  Widget _infoCard() {
    final g = _group!;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Mzunguko: ${g['cycle_type']} · Hisa: ${formatMoney(g['share_value'])}',
                style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text('Wallet ya Kikundi: ${formatMoney(g['group_wallet_balance'])}',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: Color(0xFF0B7A41))),
            if (g['join_code'] != null) ...[
              const SizedBox(height: 6),
              Text('Msimbo wa kujiunga: ${g['join_code']}',
                  style: const TextStyle(color: Color(0xFF0B7A41), fontWeight: FontWeight.w700)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _membersCard() {
    final members = (_group?['members'] as List? ?? []).cast<Map<String, dynamic>>();
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Wanachama', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 8),
            for (final m in members)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.person_outline),
                title: Text('${m['full_name']}',
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                subtitle: Text('${m['role_in_group']} · Hisa ${m['total_shares']}'),
                trailing: Text('${m['phone_number']}', style: const TextStyle(fontSize: 12)),
              ),
          ],
        ),
      ),
    );
  }

  Widget _actionsCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Vitendo', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _contribCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Kiasi cha hisa', prefixText: 'TZS '),
                  ),
                ),
                const SizedBox(width: 8),
                SizedBox(
                  width: 100,
                  child: TextField(
                    controller: _sharesCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Hisa #'),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _contribute, child: const Text('Weka Hisa')),
              ],
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _loanAmtCtrl,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Kiasi cha mkopo', prefixText: 'TZS '),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: _requestLoan, child: const Text('Omba Mkopo')),
              ],
            ),
            if (_isLeader) ...[
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _inviteCtrl,
                      decoration: const InputDecoration(
                        labelText: 'Namba za simu (kwa koma)',
                        hintText: '255713...,255714...',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(onPressed: _invite, child: const Text('Alika SMS')),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _loansCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Mikopo', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 8),
            if (_loans.isEmpty) const Text('Hakuna mikopo bado.'),
            for (final loan in _loans)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text('${loan['full_name']} — ${formatMoney(loan['requested_amount'])}',
                              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                        ),
                        StatusBadge('${loan['status']}'),
                      ],
                    ),
                    Text(
                      'Mwombaji: ${loan['applicant_user_id']} · Riba ${loan['interest_rate']}% · Miezi ${loan['repayment_months']}',
                      style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                    ),
                    if (_isLeader && loan['status'] == 'PENDING') ...[
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _approveAmtCtrl,
                              keyboardType: TextInputType.number,
                              decoration: const InputDecoration(
                                labelText: 'Kiasi kuidhinishwa',
                                prefixText: 'TZS ',
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: () => _approveLoan(loan['id'] as int),
                            child: const Text('Idhinisha'),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}
