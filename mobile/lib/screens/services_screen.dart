import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';

/// Huduma Zangu - katalogi ya huduma na kujiunga/kuondoka.
class ServicesScreen extends StatefulWidget {
  const ServicesScreen({super.key});

  @override
  State<ServicesScreen> createState() => _ServicesScreenState();
}

class _ServicesScreenState extends State<ServicesScreen> {
  List<Map<String, dynamic>> _catalog = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    try {
      final res = await api.get('/services/catalog');
      if (mounted) {
        setState(() {
          _catalog = (res['catalog'] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _toggle(Map<String, dynamic> svc) async {
    final active = svc['active'] == true;
    try {
      final api = AppState.instance.api;
      await api.post('/services/${active ? 'unsubscribe' : 'subscribe'}', {
        'serviceKey': svc['key'],
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(active ? 'Umeondoka kwenye huduma hiyo.' : 'Umejiunga na huduma hiyo.'),
      ));
      await _load();
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

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Huduma Zako', style: Theme.of(context).textTheme.headlineSmall),
        Text('Wallet ni ya msingi - nyingine unazitumia baada ya kujiunga.',
            style: TextStyle(color: Colors.grey.shade600)),
        const SizedBox(height: 16),
        for (final svc in _catalog) _serviceCard(svc),
      ],
    );
  }

  Widget _serviceCard(Map<String, dynamic> svc) {
    final on = svc['active'] == true;
    final comingSoon = svc['comingSoon'] == true;
    final base = svc['baseService'] == true;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.circle, size: 12, color: _color(svc)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text('${svc['emoji']} ${svc['swahili'] ?? svc['name']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                ),
                Chip(
                  label: Text(on ? 'IMEWASHWA' : 'HAIJAWASHWA',
                      style: TextStyle(fontSize: 11, color: on ? Colors.green.shade800 : Colors.grey.shade700)),
                  backgroundColor: on ? Colors.green.shade50 : Colors.grey.shade200,
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text('${svc['description'] ?? ''}'),
            const SizedBox(height: 8),
            Text(
              base ? 'Huduma ya msingi' : 'KYC Level ${svc['requiresKyc']} inahitajika'
                  '${comingSoon ? ' · Inakuja hivi karibuni' : ''}',
              style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
            ),
            if (!base && !comingSoon) ...[
              const SizedBox(height: 10),
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.tonal(
                  onPressed: () => _toggle(svc),
                  child: Text(on ? 'Ondoka' : 'Jiunge'),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Color _color(Map<String, dynamic> svc) {
    final hex = (svc['color'] as String? ?? '#0B7A41').replaceFirst('#', '');
    return Color(int.parse('FF$hex', radix: 16));
  }
}
