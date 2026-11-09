#pragma once
#include <Arduino.h>
class TwoWire : public Stream {
 public:
  void begin();
  void begin(uint8_t address);
  void begin(int address);
#if defined(AUTOINO_STUB_ESP32)
  bool begin(int sda, int scl, uint32_t frequency = 0);
  bool begin(uint8_t slaveAddr, int sda, int scl, uint32_t frequency);
#endif
  void beginTransmission(uint8_t address);
  uint8_t endTransmission(void);
  uint8_t endTransmission(uint8_t sendStop);
  uint8_t requestFrom(uint8_t address, uint8_t quantity);
  void onReceive(void (*)(int));
};
extern TwoWire Wire;
