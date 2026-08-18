import 'package:flutter/material.dart';
import 'screens/splash_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const AfrikobaApp());
}

class AfrikobaApp extends StatelessWidget {
  const AfrikobaApp({super.key});

  static const brandGreen = Color(0xFF0B7A41);
  static const brandBlue = Color(0xFF155E9C);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Afrikoba Global',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: brandGreen,
          primary: brandGreen,
        ),
        scaffoldBackgroundColor: const Color(0xFFF4F6F5),
        appBarTheme: const AppBarTheme(
          backgroundColor: brandGreen,
          foregroundColor: Colors.white,
          elevation: 0,
        ),
        inputDecorationTheme: const InputDecorationTheme(
          border: OutlineInputBorder(),
          isDense: true,
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(48),
            textStyle: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ),
      home: const SplashScreen(),
    );
  }
}