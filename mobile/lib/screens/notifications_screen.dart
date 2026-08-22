import 'package:flutter/material.dart';
import '../core/app_state.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<Map<String, dynamic>> _notifications = [];
  int _unreadCount = 0;
  int _page = 1;
  int _totalPages = 1;
  // ignore: prefer_final_fields
  bool _unreadOnly = false;
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
      final r = await api.get('/notifications?page=$_page&limit=20&unreadOnly=$_unreadOnly');
      final count = await api.get('/notifications/unread-count');
      if (mounted) {
        setState(() {
          _notifications = (r['notifications'] as List).cast<Map<String, dynamic>>();
          _totalPages = r['totalPages'] ?? 1;
          _unreadCount = count['count'] ?? 0;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _markRead(int id) async {
    try {
      await AppState.instance.api.put('/notifications/$id/read', {});
      _load();
    } catch (_) {}
  }

  Future<void> _markAllRead() async {
    try {
      await AppState.instance.api.put('/notifications/read-all', {});
      _load();
    } catch (_) {}
  }

  Color _typeColor(String type) {
    switch (type) {
      case 'TRANSACTION': return const Color(0xFF0B7A41);
      case 'VICOBA': return const Color(0xFF0B7A41);
      case 'ROSCA': return const Color(0xFF155E9C);
      case 'P2P': return const Color(0xFF6D3FB8);
      case 'SECURITY': return const Color(0xFFC62828);
      case 'PROMO': return const Color(0xFFB26A00);
      default: return const Color(0xFF155E9C);
    }
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('Arifa', style: Theme.of(context).textTheme.headlineSmall),
                    TextButton(
                      onPressed: _markAllRead,
                      child: const Text('Soma Zote'),
                    ),
                  ],
                ),
                Text('Hazijasomwa: $_unreadCount',
                    style: TextStyle(color: Colors.grey.shade600, fontSize: 12)),
                const SizedBox(height: 12),
                if (_notifications.isEmpty)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Center(
                        child: Text('Hakuna arifa.',
                            style: TextStyle(color: Colors.grey.shade500)),
                      ),
                    ),
                  ),
                ..._notifications.map((n) => Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    leading: CircleAvatar(
                      backgroundColor: _typeColor(n['type'] ?? 'INFO').withValues(alpha: .15),
                      child: Icon(
                        _typeIcon(n['type'] ?? 'INFO'),
                        color: _typeColor(n['type'] ?? 'INFO'),
                        size: 20,
                      ),
                    ),
                    title: Text(n['title'] ?? '',
                        style: TextStyle(
                          fontWeight: n['read_at'] == null ? FontWeight.w700 : FontWeight.w400,
                          fontSize: 14,
                        )),
                    subtitle: Text(n['body'] ?? '',
                        maxLines: 2, overflow: TextOverflow.ellipsis),
                    trailing: n['read_at'] == null
                        ? IconButton(
                            icon: const Icon(Icons.done_all, size: 18),
                            onPressed: () => _markRead(n['id']),
                          )
                        : null,
                  ),
                )),
                if (_totalPages > 1)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      IconButton(
                        onPressed: _page > 1 ? () { _page--; _load(); } : null,
                        icon: const Icon(Icons.chevron_left),
                      ),
                      Text('$_page / $_totalPages'),
                      IconButton(
                        onPressed: _page < _totalPages ? () { _page++; _load(); } : null,
                        icon: const Icon(Icons.chevron_right),
                      ),
                    ],
                  ),
              ],
            ),
    );
  }

  IconData _typeIcon(String type) {
    switch (type) {
      case 'TRANSACTION': return Icons.receipt_long;
      case 'VICOBA': return Icons.groups;
      case 'ROSCA': return Icons.sync_alt;
      case 'P2P': return Icons.trending_up;
      case 'SECURITY': return Icons.security;
      case 'PROMO': return Icons.campaign;
      default: return Icons.info_outline;
    }
  }
}
