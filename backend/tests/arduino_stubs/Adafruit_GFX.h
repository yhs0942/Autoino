#pragma once
#include <Arduino.h>
class Adafruit_GFX : public Print {
 public:
  void setTextSize(uint8_t size);
  void setTextColor(uint16_t color);
  void setCursor(int16_t x, int16_t y);
};
