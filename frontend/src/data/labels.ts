import type { ModulePinRole, PinCapability, PinRestrictionKind, SpecConfidence } from '../types'

// 화면 표시용 라벨 모음

export const CAPABILITY_LABELS: Record<PinCapability, string> = {
  digital: '디지털',
  analog: '아날로그',
  pwm: 'PWM',
  interrupt: '인터럽트',
  'i2c-sda': 'I²C SDA',
  'i2c-scl': 'I²C SCL',
  'spi-mosi': 'SPI MOSI',
  'spi-miso': 'SPI MISO',
  'spi-sck': 'SPI SCK',
  'spi-ss': 'SPI SS',
  'uart-rx': 'UART RX',
  'uart-tx': 'UART TX',
  dac: 'DAC',
  touch: '터치',
}

export const RESTRICTION_LABELS: Record<PinRestrictionKind, string> = {
  'input-only': '입력 전용',
  'no-internal-pull': '내부 풀업 없음',
  strapping: '스트래핑(부팅)',
  jtag: 'JTAG',
  'usb-serial': 'USB 시리얼',
  'adc2-wifi': 'ADC2 · Wi-Fi 충돌',
  'onboard-led': '내장 LED',
  'interrupt-caveat': '인터럽트 주의',
}

export const ROLE_LABELS: Record<ModulePinRole, string> = {
  power: '전원',
  ground: 'GND',
  signal: '신호',
  passive: '수동',
  source: '전원 출력',
  load: '모터 단자',
  drive: '모터 출력',
}

export const CONFIDENCE_LABELS: Record<SpecConfidence, string> = {
  official: '공식 사양',
  typical: '대표값 · 제품 확인 필요',
  varies: '제품별 상이',
}
