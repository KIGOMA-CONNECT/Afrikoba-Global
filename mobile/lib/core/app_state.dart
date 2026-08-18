import 'session.dart';
import 'api_client.dart';

/// Hali ya programu nzima (singleton).
/// - session: hifadhi ya token + mtumiaji (shared_preferences)
/// - api: klienti ya API inayotumia token ya kipindi
class AppState {
  AppState._();
  static final AppState instance = AppState._();

  final Session session = Session();
  late final ApiClient api = ApiClient(session);
}
