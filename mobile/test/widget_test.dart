import 'package:flutter_test/flutter_test.dart';
import 'package:afrikoba_app/core/format.dart';

void main() {
  test('formatMoney formats TZS with thousands separators', () {
    expect(formatMoney(100000), 'TZS 100,000');
    expect(formatMoney(0), 'TZS 0');
    expect(formatMoney(null), 'TZS 0');
  });
}
