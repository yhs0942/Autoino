#pragma once
#include <Arduino.h>
#if defined(AUTOINO_STUB_ESP32)
#error "ESP32 에서는 Servo.h 대신 ESP32Servo.h 를 써야 합니다"
#endif
class Servo {
 public:
  uint8_t attach(int pin);
  int attach(int pin, int minUs, int maxUs);
  void write(int value);
  void writeMicroseconds(int value);
};
