#pragma once
#include <Arduino.h>
#define SPI_MODE0 0x00
class SPISettings {
 public:
  SPISettings(uint32_t clock, uint8_t bitOrder, uint8_t dataMode);
};
#if defined(AUTOINO_STUB_ESP32)
#define VSPI 3
#define HSPI 2
#endif
class SPIClass {
 public:
#if defined(AUTOINO_STUB_ESP32)
  explicit SPIClass(uint8_t spi_bus = HSPI);
  void begin(int8_t sck = -1, int8_t miso = -1, int8_t mosi = -1, int8_t ss = -1);
#else
  static void begin();
#endif
  void beginTransaction(SPISettings settings);
  uint8_t transfer(uint8_t data);
  void endTransaction(void);
};
extern SPIClass SPI;
