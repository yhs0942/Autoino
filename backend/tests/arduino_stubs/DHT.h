#pragma once
#include <Arduino.h>
#define DHT11 11
#define DHT22 22
class DHT {
 public:
  DHT(uint8_t pin, uint8_t type);
  void begin();
  float readTemperature();
  float readHumidity();
};
