// Autoino 테스트용 Arduino API 스텁 (구문·타입 검사 전용, 실제 동작 없음).
// 실제 Arduino 코어의 공개 함수 시그니처를 흉내 낸다. 보드용 컴파일을 대신하지 않는다.
#pragma once
#include <stdint.h>
#include <stddef.h>

#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x0
#define OUTPUT 0x1
#define INPUT_PULLUP 0x2
#define MSBFIRST 1
#define HEX 16
typedef uint8_t byte;
#define _BV(bit) (1 << (bit))

void pinMode(uint8_t pin, uint8_t mode);
void digitalWrite(uint8_t pin, uint8_t val);
int digitalRead(uint8_t pin);
int analogRead(uint8_t pin);
void analogWrite(uint8_t pin, int val);
unsigned long millis(void);
long map(long value, long fromLow, long fromHigh, long toLow, long toHigh);
void delayMicroseconds(unsigned int us);
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000L);

class Print {
 public:
  size_t write(uint8_t c);
  size_t write(int c) { return write((uint8_t)c); }
  size_t print(const char *s);
  size_t print(int n, int base = 10);
  size_t print(unsigned int n, int base = 10);
  size_t print(long n, int base = 10);
  size_t print(unsigned long n, int base = 10);
  size_t print(double n, int digits = 2);
  size_t println(const char *s);
  size_t println(int n, int base = 10);
  size_t println(unsigned int n, int base = 10);
  size_t println(long n, int base = 10);
  size_t println(unsigned long n, int base = 10);
  size_t println(double n, int digits = 2);
  size_t println(void);
};

class Stream : public Print {
 public:
  int available();
  int read();
};

#if defined(AUTOINO_STUB_ESP32)
#define SERIAL_8N1 0x800001c
class HardwareSerial : public Stream {
 public:
  void begin(unsigned long baud, uint32_t config = SERIAL_8N1, int8_t rxPin = -1, int8_t txPin = -1);
};
extern HardwareSerial Serial, Serial1, Serial2;
#else
#define SERIAL_8N1 0x06
class HardwareSerial : public Stream {
 public:
  void begin(unsigned long baud);
  void begin(unsigned long baud, uint8_t config);
};
extern HardwareSerial Serial;
#if defined(AUTOINO_STUB_MEGA)
extern HardwareSerial Serial1, Serial2, Serial3;
#endif
// AVR 레지스터와 인터럽트 (SPI 주변장치 코드용)
extern volatile uint8_t SPCR, SPDR;
#define SPE 6
#define SPIE 7
#define ISR(vector) extern "C" void vector(void)
static const uint8_t MISO = 12;
static const uint8_t A0 = 14, A1 = 15, A2 = 16, A3 = 17, A4 = 18, A5 = 19, A6 = 20, A7 = 21;
#if defined(AUTOINO_STUB_MEGA)
static const uint8_t A8 = 62, A9 = 63, A10 = 64, A11 = 65, A12 = 66, A13 = 67, A14 = 68, A15 = 69;
#endif
#endif
