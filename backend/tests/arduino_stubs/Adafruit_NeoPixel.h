#pragma once
#include <Arduino.h>
#define NEO_GRB 0x52
#define NEO_KHZ800 0
class Adafruit_NeoPixel {
 public:
  Adafruit_NeoPixel(uint16_t n, int16_t pin, uint16_t type);
  void begin();
  void clear();
  void show();
  void setBrightness(uint8_t b);
  void setPixelColor(uint16_t n, uint32_t c);
  static uint32_t Color(uint8_t r, uint8_t g, uint8_t b);
};
