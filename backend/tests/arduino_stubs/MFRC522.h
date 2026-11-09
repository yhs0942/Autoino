#pragma once
#include <Arduino.h>
class MFRC522 {
 public:
  struct Uid {
    uint8_t size;
    uint8_t uidByte[10];
  };
  Uid uid;
  MFRC522(uint8_t ss, uint8_t rst);
  void PCD_Init();
  bool PICC_IsNewCardPresent();
  bool PICC_ReadCardSerial();
  uint8_t PICC_HaltA();
};
