#pragma once
#include <Adafruit_GFX.h>
#include <Wire.h>
#define SSD1306_SWITCHCAPVCC 2
#define SSD1306_WHITE 1
class Adafruit_SSD1306 : public Adafruit_GFX {
 public:
  Adafruit_SSD1306(uint8_t w, uint8_t h, TwoWire *wire, int8_t rst);
  bool begin(uint8_t vcc, uint8_t addr);
  void clearDisplay();
  void display();
};
