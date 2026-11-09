#pragma once
#include <Arduino.h>
#if defined(AUTOINO_STUB_ESP32)
#error "SoftwareSerial 은 AVR 코어에 포함된 라이브러리입니다"
#endif
class SoftwareSerial : public Stream {
 public:
  SoftwareSerial(uint8_t receivePin, uint8_t transmitPin, bool inverse_logic = false);
  void begin(long speed);
};
