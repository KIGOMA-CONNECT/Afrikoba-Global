import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

const List<String> _eventTypes = [
  'HARUSI', 'SEND_OFF', 'BIRTHDAY', 'GRADUATION', 'MAHAFALI', 'KIPAIMARA',
  'COMMUNION', 'KITCHEN_PARTY', 'BABY_SHOWER', 'FAMILY', 'UKOO', 'MTAJI',
  'REUNION', 'TAASISI', 'KIUNDU', 'COMMUNITY', 'OTHER',
];
const List<String> _ownerTypes = [
  'INDIVIDUAL', 'COUPLE', 'FAMILY', 'CLAN', 'GROUP', 'ORGANIZATION',
];
const List<String> _cadences = ['', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'CUSTOM'];

/// Matukio ya Kijamii - kuchangia (changia) na kuweka akiba (savings).
class EventsScreen extends StatefulWidget {
  const EventsScreen({super.key});

  @override
  State<EventsScreen> createState() => _EventsScreenState();
}

class _EventsScreenState extends State<EventsScreen> {
  List<Map<String, dynamic>> _events = [];
  bool _loading = true;
  int? _myUserId;

  final _nameCtrl = TextEditingController();
  final _targetCtrl = TextEditingController();
  final _descCtrl = TextEditingController();
  final _dateCtrl = TextEditingController();
  final _deadlineCtrl = TextEditingController();
  String _type = 'HARUSI';
  String _ownerType = 'INDIVIDUAL';
  String _cadence = '';
  String _sessionAmt = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _targetCtrl.dispose();
    _descCtrl.dispose();
    _dateCtrl.dispose();
    _deadlineCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final user = await AppState.instance.session.user();
      final res = await AppState.instance.api.get('/events');
      if (mounted) {
        setState(() {
          _events = (res['events'] as List).cast<Map<String, dynamic>>();
          _myUserId = user?['id'] as int?;
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
    final rules = <String, dynamic>{};
    try {
      await AppState.instance.api.post('/events', {
        'name': _nameCtrl.text.trim(),
        'eventType': _type,
        'description': _descCtrl.text.trim().isEmpty ? null : _descCtrl.text.trim(),
        'ownerType': _ownerType,
        'targetAmount': double.parse(_targetCtrl.text.trim()),
        'eventDate': _dateCtrl.text.trim().isEmpty ? null : _dateCtrl.text.trim(),
        'contributionDeadline': _deadlineCtrl.text.trim().isEmpty ? null : _deadlineCtrl.text.trim(),
        'savingsCadence': _cadence.isEmpty ? null : _cadence,
        'savingsSessionAmount': _sessionAmt.trim().isEmpty ? null : double.parse(_sessionAmt.trim()),
        'rules': rules,
      });
      if (!mounted) return;
      _toast('Tukio limeundwa.');
      _nameCtrl.clear();
      _targetCtrl.clear();
      _descCtrl.clear();
      _dateCtrl.clear();
      _deadlineCtrl.clear();
      _sessionAmt = '';
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
      isScrollControlled: true,
      builder: (_) => Padding(
        padding: EdgeInsets.only(
          left: 20,
          right: 20,
          top: 20,
          bottom: MediaQuery.of(context).viewInsets.bottom + 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('Unda Tukio (Harusi, Send-off, Mahafali...)',
                  style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              const SizedBox(height: 12),
              TextField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: 'Jina la Tukio'),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _type,
                decoration: const InputDecoration(labelText: 'Aina ya Tukio'),
                items: _eventTypes
                    .map((e) => DropdownMenuItem(value: e, child: Text(e)))
                    .toList(),
                onChanged: (v) => setState(() => _type = v ?? 'HARUSI'),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _ownerType,
                decoration: const InputDecoration(labelText: 'Aina ya Mmiliki'),
                items: _ownerTypes
                    .map((o) => DropdownMenuItem(value: o, child: Text(o)))
                    .toList(),
                onChanged: (v) => setState(() => _ownerType = v ?? 'INDIVIDUAL'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _targetCtrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Lengo (TZS)', prefixText: 'TZS '),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _dateCtrl,
                decoration: const InputDecoration(labelText: 'Tarehe ya Tukio (YYYY-MM-DD)'),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _deadlineCtrl,
                decoration: const InputDecoration(labelText: 'Mwisho wa Mchango (YYYY-MM-DD)'),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _cadence,
                decoration: const InputDecoration(labelText: 'Kadensi ya Akiba'),
                items: _cadences
                    .map((c) => DropdownMenuItem(
                        value: c, child: Text(c.isEmpty ? 'Hakuna mpango wa akiba' : c)))
                    .toList(),
                onChanged: (v) => setState(() => _cadence = v ?? ''),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: TextEditingController(text: _sessionAmt),
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Kiasi cha Kila Kipindi (TZS)'),
                onChanged: (v) => _sessionAmt = v,
              ),
              const SizedBox(height: 16),
              FilledButton(onPressed: _create, child: const Text('Unda Tukio')),
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
              const Expanded(
                child: Text('Matukio', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18)),
              ),
              FilledButton.icon(
                onPressed: _openCreate,
                icon: const Icon(Icons.add),
                label: const Text('Unda'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text('Kuchangia na kuweka akiba kwa harusi, send-off, mahafali na zaidi.',
              style: TextStyle(color: Colors.grey)),
          const SizedBox(height: 12),
          if (_events.isEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Text('Huna matukio bado. Unda tukio lako la kwanza!',
                  textAlign: TextAlign.center),
            ),
          for (final ev in _events) _eventCard(ev),
        ],
      ),
    );
  }

  Widget _eventCard(Map<String, dynamic> ev) {
    final collected = (ev['fundraising_raised'] ?? 0) + (ev['savings_raised'] ?? 0);
    return Card(
      child: ListTile(
        leading: const CircleAvatar(
          backgroundColor: Color(0xFF0B7A41),
          child: Icon(Icons.celebration_outlined, color: Colors.white),
        ),
        title: Text('${ev['name']}'),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('${ev['event_type']} · Lengo ${formatMoney(ev['target_amount'])}'),
            Text('Imechangwa ${formatMoney(collected)} · ${ev['donation_count'] ?? 0} michango'),
          ],
        ),
        isThreeLine: true,
        trailing: StatusBadge('${ev['status']}'),
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => EventDetailScreen(eventId: ev['id'] as int, myUserId: _myUserId),
            ),
          );
          _load();
        },
      ),
    );
  }
}

/// Maelezo ya tukio: dashibodi, kuchangia, bajeti, orodha ya michango.
class EventDetailScreen extends StatefulWidget {
  final int eventId;
  final int? myUserId;
  const EventDetailScreen({super.key, required this.eventId, this.myUserId});

  @override
  State<EventDetailScreen> createState() => _EventDetailScreenState();
}

class _EventDetailScreenState extends State<EventDetailScreen> {
  Map<String, dynamic>? _dash;
  List<Map<String, dynamic>> _contribs = [];
  List<Map<String, dynamic>> _budget = [];
  bool _loading = true;

  final _amtCtrl = TextEditingController();
  final _catCtrl = TextEditingController();
  final _bDescCtrl = TextEditingController();
  final _bAmtCtrl = TextEditingController();
  String _mode = 'FUNDRAISING';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _amtCtrl.dispose();
    _catCtrl.dispose();
    _bDescCtrl.dispose();
    _bAmtCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await AppState.instance.api.get('/events/${widget.eventId}/dashboard');
      final c = await AppState.instance.api.get('/events/${widget.eventId}/contributions?limit=50');
      final b = await AppState.instance.api.get('/events/${widget.eventId}/budget');
      if (mounted) {
        setState(() {
          _dash = d['dashboard'] as Map<String, dynamic>;
          _contribs = (c['contributions'] as List).cast<Map<String, dynamic>>();
          _budget = (b['items'] as List).cast<Map<String, dynamic>>();
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
      final res = await AppState.instance.api.post(
          '/events/${widget.eventId}/contributions',
          {'amount': double.parse(_amtCtrl.text.trim()), 'mode': _mode});
      if (!mounted) return;
      _toast('${res['message']}');
      _amtCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      _toast(e.message, ok: false);
    } catch (_) {
      if (!mounted) return;
      _toast('Hitilafu.', ok: false);
    }
  }

  Future<void> _addBudget() async {
    try {
      await AppState.instance.api.post('/events/${widget.eventId}/budget', {
        'category': _catCtrl.text.trim(),
        'description': _bDescCtrl.text.trim().isEmpty ? null : _bDescCtrl.text.trim(),
        'amount': double.parse(_bAmtCtrl.text.trim()),
      });
      if (!mounted) return;
      _toast('Bajeti imeongezwa.');
      _catCtrl.clear();
      _bDescCtrl.clear();
      _bAmtCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      _toast(e.message, ok: false);
    } catch (_) {
      if (!mounted) return;
      _toast('Hitilafu.', ok: false);
    }
  }

  Future<void> _updateStatus(String status) async {
    try {
      await AppState.instance.api.patch('/events/${widget.eventId}', {'status': status});
      if (!mounted) return;
      _toast(status == 'CLOSED' ? 'Tukio limefungwa.' : 'Tukio limeghairiwa.');
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      _toast(e.message, ok: false);
    }
  }

  bool get _isOwner {
    if (_dash == null || widget.myUserId == null) return false;
    final ev = _dash!['event'] as Map<String, dynamic>;
    return ev['ownerUserId'] == widget.myUserId;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_dash?['event']?['name'] ?? 'Tukio')),
      body: _loading || _dash == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _summaryCard(),
                  const SizedBox(height: 12),
                  _contributeCard(),
                  const SizedBox(height: 12),
                  _budgetCard(),
                  const SizedBox(height: 12),
                  _contributionsCard(),
                ],
              ),
            ),
    );
  }

  Widget _summaryCard() {
    final ev = _dash!['event'] as Map<String, dynamic>;
    final s = _dash!['summary'] as Map<String, dynamic>;
    final stats = _dash!['stats'] as Map<String, dynamic>;
    final collected = s['collected'] as Map<String, dynamic>;
    final active = ev['status'] == 'ACTIVE';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${ev['name']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 17)),
                ),
                StatusBadge('${ev['status']}'),
              ],
            ),
            const SizedBox(height: 4),
            Text('${ev['eventType']} · Siku: ${formatDate('${ev['eventDate']}')}'),
            if (ev['description'] != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('${ev['description']}', style: const TextStyle(color: Colors.grey)),
              ),
            const SizedBox(height: 10),
            Row(
              children: [
                _stat('Lengo', formatMoney(s['target'])),
                _stat('Imekusanywa', formatMoney(collected['total'])),
                _stat('Inabaki', formatMoney(s['remaining'])),
              ],
            ),
            const SizedBox(height: 6),
            Text('Maendeleo: ${s['progress']}% · Wachangiaji ${stats['contributors']} · Michango ${stats['donations']}'),
            Text('Changia: ${formatMoney(collected['fundraising'])} · Akiba: ${formatMoney(collected['savings'])}',
                style: const TextStyle(fontWeight: FontWeight.w600)),
            if (_isOwner && active)
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Row(
                  children: [
                    OutlinedButton(
                      onPressed: () => _updateStatus('CLOSED'),
                      child: const Text('Funga (Close)'),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton(
                      onPressed: () => _updateStatus('CANCELLED'),
                      style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                      child: const Text('Ghairi'),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: const TextStyle(fontWeight: FontWeight.w700)),
          Text(label, style: const TextStyle(fontSize: 11, color: Colors.grey)),
        ],
      ),
    );
  }

  Widget _contributeCard() {
    final ev = _dash!['event'] as Map<String, dynamic>;
    final active = ev['status'] == 'ACTIVE';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Changia / Weka Akiba', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(
              controller: _amtCtrl,
              keyboardType: TextInputType.number,
              enabled: active,
              decoration: const InputDecoration(labelText: 'Kiasi (TZS)', prefixText: 'TZS '),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: _mode,
              decoration: const InputDecoration(labelText: 'Njia'),
              items: const [
                DropdownMenuItem(value: 'FUNDRAISING', child: Text('Changia mara moja (FUNDRAISING)')),
                DropdownMenuItem(value: 'SAVINGS', child: Text('Weka kidogo kidogo (SAVINGS)')),
              ],
              onChanged: (v) => setState(() => _mode = v ?? 'FUNDRAISING'),
            ),
            const SizedBox(height: 10),
            if (active)
              SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: _contribute, child: const Text('Kamilisha Mchango')),
              )
            else
              const Text('Tukio hili halikubali michango tena.',
                  style: TextStyle(color: Colors.grey)),
          ],
        ),
      ),
    );
  }

  Widget _budgetCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Bajeti ya Tukio', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            if (_isOwner) ...[
              TextField(
                controller: _catCtrl,
                decoration: const InputDecoration(labelText: 'Kategoria'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _bDescCtrl,
                decoration: const InputDecoration(labelText: 'Maelezo'),
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _bAmtCtrl,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Kiasi (TZS)', prefixText: 'TZS '),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: FilledButton(onPressed: _addBudget, child: const Text('Ongeza kwenye Bajeti')),
              ),
            ],
            const SizedBox(height: 6),
            for (final b in _budget)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.receipt_long),
                title: Text('${b['category']}'),
                subtitle: Text('${b['description'] ?? '-'}'),
                trailing: Text(formatMoney(b['amount'])),
              ),
          ],
        ),
      ),
    );
  }

  Widget _contributionsCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Michango', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            if (_contribs.isEmpty)
              const Text('Hakuna michango bado.', style: TextStyle(color: Colors.grey))
            else
              for (final c in _contribs)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.person_outline),
                  title: Text('${c['contributor']}'),
                  subtitle: Text('${c['mode']} · ${formatDate('${c['created_at']}')}'),
                  trailing: Text(formatMoney(c['amount'])),
                ),
          ],
        ),
      ),
    );
  }
}