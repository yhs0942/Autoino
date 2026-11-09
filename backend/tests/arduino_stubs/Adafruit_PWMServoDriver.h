// 구문 검사용 최소 선언 (Adafruit PWM Servo Driver Library)
#pragma once
#include <Arduino.h>
#include <Wire.h>

class Adafruit_PWMServoDriver {
 public:
  Adafruit_PWMServoDriver(const uint8_t addr = 0x40, TwoWire &i2c = Wire) { (void)addr; (void)i2c; }
  bool begin(uint8_t prescale = 0) { (void)prescale; return true; }
  void setOscillatorFrequency(uint32_t freq) { (void)freq; }
  void setPWMFreq(float freq) { (void)freq; }
  uint8_t setPWM(uint8_t num, uint16_t on, uint16_t off) { (void)num; (void)on; (void)off; return 0; }
  void writeMicroseconds(uint8_t num, uint16_t microseconds) { (void)num; (void)microseconds; }
};
