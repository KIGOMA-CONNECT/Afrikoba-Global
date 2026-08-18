import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../widgets/service_lock.dart';
import 'group_detail_screen.dart';

/// VICOBA - vikundi vya akiba na mikopo.
/// Imezungukwa na ServiceLock: mtumiaji anajiunga na VICOBA kwanza.
class VicobaScreen extends StatelessWidget {
  const VicobaScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const ServiceLock(
      serviceKey: 'VICOBA',
      serviceName: 'VICOBA',
      child: _VicobaBody(),
    );
  }
}

class _VicobaBody extends StatefulWidget {
  const _VicobaBody();

  @override
  State<_VicobaBody> createState() => _VicobaBodyState();
}

class _VicobaBodyState extends State<_VicobaBody> {
  List<Map<String, dynamic>> _groups = [];
  bool _loading = true;

  final _nameCtrl = TextEditingController();
  final _joinCtrl = TextEditingController();
  String _cycleType = 'WEEKLY';
  final _shareCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _joinCtrl.dispose();
    _shareCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    try {
      final res = await api.get('/vicoba/groups');
      if (mounted) {
        setState(() {
          _groups = (res['groups'] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _create() async {
    if (_nameCtrl.text.trim().isEmpty || _shareCtrl.text.trim().isEmpty) {
      _toast('Jaza jina la kikundi na thamani ya hisa.', ok: false);
      return;
    }
    try {
      await AppState.instance.api.post('/vicoba/groups', {
        'groupName': _nameCtrl.text.trim(),
        'cycleType': _cycleType,
        'shareValue': double.parse(_shareCtrl.text.trim()),
      });
      if (!mounted) return;
      _toast('Kikundi kimeundwa! Waambie wanachama wajiunge kwa msimbo wa kikundi.');
      _nameCtrl.clear();
      _shareCtrl.clear();
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

  Future<void> _join() async {
    if (_joinCtrl.text.trim().isEmpty) {
      _toast('Weka msimbo wa kujiunga.', ok: false);
      return;
    }
    try {
      final res = await AppState.instance.api
          .post('/vicoba/groups/join', {'joinCode': _joinCtrl.text.trim().toUpperCase()});
      if (!mounted) return;
      _toast('${res['message']}');
      _joinCtrl.clear();
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

  void _toast(String msg, {bool ok = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: ok ? Colors.green : Colors.red),
    );
  }

  void _openCreate() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Unda Kikundi cha VICOBA',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: 14),
              TextField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: 'Jina la Kikundi'),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _cycleType,
                decoration: const InputDecoration(labelText: 'Mzunguko'),
                items: const [
                  DropdownMenuItem(value: 'WEEKLY', child: Text('Kila wiki')),
                  DropdownMenuItem(value: 'MONTHLY', child: Text('Kila mwezi')),
                ],
                onChanged: (v) => setState(() => _cycleType = v ?? 'WEEKLY'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _shareCtrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Thamani ya Hisa (TZS)', prefixText: 'TZS '),
              ),
              const SizedBox(height: 14),
              FilledButton(onPressed: _create, child: const Text('Unda Kikundi')),
            ],
          ),
        ),
      ),
    );
  }

  void _openJoin() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Jiunge kwa Msimbo wa Kikundi',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: 14),
              TextField(
                controller: _joinCtrl,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                  labelText: 'Msimbo wa Kujiunga',
                  hintText: 'MWANZO2026',
                ),
              ),
              const SizedBox(height: 14),
              FilledButton(onPressed: _join, child: const Text('Jiunga')),
            ],
          ),
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
              Expanded(
                child: FilledButton.icon(
                  onPressed: _openCreate,
                  icon: const Icon(Icons.add),
                  label: const Text('Unda Kikundi'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _openJoin,
                  icon: const Icon(Icons.group_add),
                  label: const Text('Jiunge kwa Msimbo'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_groups.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Hujajiunga na kikundi chochote. Unda kikundi au weka msimbo wa kujiunga.',
                  textAlign: TextAlign.center),
            ),
          for (final g in _groups) _groupCard(g),
        ],
      ),
    );
  }

  Widget _groupCard(Map<String, dynamic> g) {
    final isLeader = ['MWENYEKITI', 'MWEKAHAZINA', 'KATIBU'].contains(g['role_in_group']);
    return Card(
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: const Color(0xFF155E9C).withValues(alpha: .12),
          child: const Icon(Icons.groups, color: Color(0xFF155E9C)),
        ),
        title: Text('${g['group_name']}'),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${g['cycle_type']} · Hisa ${g['share_value']} · Wajibu wako: ${g['role_in_group'] ?? '-'}'),
            if (isLeader && g['join_code'] != null)
              Text('Msimbo wa kujiunga: ${g['join_code']}',
                  style: const TextStyle(color: Color(0xFF0B7A41), fontWeight: FontWeight.w600)),
          ],
        ),
        isThreeLine: true,
        trailing: const Icon(Icons.chevron_right),
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute(builder: (_) => GroupDetailScreen(groupId: g['id'] as int)),
          );
          _load();
        },
      ),
    );
  }
}
