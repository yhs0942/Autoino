#pragma once
#include <Arduino.h>
class TM1637Display {
 public:
  TM1637Display(uint8_t clk, uint8_t dio);
  void setBrightness(uint8_t b);
  void showNumberDec(int num);
};
