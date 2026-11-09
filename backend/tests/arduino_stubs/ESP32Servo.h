#pragma once
#include <Arduino.h>
#if !defined(AUTOINO_STUB_ESP32)
#error "ESP32Servo 는 ESP32 전용입니다"
#endif
class Servo {
 public:
  int attach(int pin);
  int attach(int pin, int minUs, int maxUs);
  void write(int value);
  void writeMicroseconds(int value);
};
