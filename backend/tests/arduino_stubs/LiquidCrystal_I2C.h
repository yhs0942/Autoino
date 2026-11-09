#pragma once
#include <Arduino.h>
class LiquidCrystal_I2C : public Print {
 public:
  LiquidCrystal_I2C(uint8_t lcd_Addr, uint8_t lcd_cols, uint8_t lcd_rows);
  void init();
  void backlight();
  void setCursor(uint8_t col, uint8_t row);
};
