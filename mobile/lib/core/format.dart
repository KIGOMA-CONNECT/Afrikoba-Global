import 'package:intl/intl.dart';

String formatMoney(num? n) {
  final f = NumberFormat('#,##0', 'en_US');
  return 'TZS ${f.format((n ?? 0).round())}';
}

String formatDate(String? iso) {
  if (iso == null || iso.isEmpty) return '';
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  return DateFormat('dd/MM/yyyy HH:mm').format(dt.toLocal());
}
