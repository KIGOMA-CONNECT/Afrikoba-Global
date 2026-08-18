import 'package:flutter/material.dart';

/// Nembo (badge) ya hali ya kipengee - rangi inategemea hali.
class StatusBadge extends StatelessWidget {
  final String status;
  const StatusBadge(this.status, {super.key});

  @override
  Widget build(BuildContext context) {
    final s = status.toUpperCase();
    final ok = {'SUCCESS', 'VERIFIED_ACTIVE', 'ACTIVE', 'DISBURSED', 'PASSED', 'RELEASED', 'PAID'};
    final pending = {'PENDING', 'WAITING_MEMBERS', 'PENDING_AUDIT', 'LOCKED', 'PENDING_APPROVAL'};
    final bad = {'FAILED', 'REJECTED', 'SKIPPED', 'DEFAULTED', 'SUSPENDED', 'EXPIRED'};

    Color bg;
    Color fg;
    if (ok.contains(s)) {
      bg = Colors.green.shade100;
      fg = Colors.green.shade800;
    } else if (pending.contains(s)) {
      bg = Colors.orange.shade100;
      fg = Colors.orange.shade900;
    } else if (bad.contains(s)) {
      bg = Colors.red.shade100;
      fg = Colors.red.shade800;
    } else {
      bg = Colors.blueGrey.shade100;
      fg = Colors.blueGrey.shade800;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(6)),
      child: Text(
        status,
        style: TextStyle(color: fg, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }
}
