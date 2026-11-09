// Autoino 공통 타입 정의
// 정의 데이터(Board, Module)와 작업 공간 상태(PlacedModule 등)를 분리한다.
// 모든 정의 데이터는 JSON 으로 직렬화 가능한 형태만 사용한다(함수·클래스 금지).

/** 보드 핀이 지원하는 기능. 향후 자동 핀 배정 엔진이 사용한다. */
export type PinCapability =
  | 'digital'
  | 'analog'
  | 'pwm'
  | 'interrupt'
  | 'i2c-sda'
  | 'i2c-scl'
  | 'spi-mosi'
  | 'spi-miso'
  | 'spi-sck'
  | 'spi-ss'
  | 'uart-rx'
  | 'uart-tx'
  | 'dac'
  | 'touch'

/** digital/analog = GPIO, power = 전원·GND·기준 전압, control = 리셋(EN) 등 제어 핀 */
export type BoardPinGroup = 'digital' | 'analog' | 'power' | 'control'

/** 핀 사용 시 주의해야 할 제약. 자동 핀 배정과 검증이 참고한다. */
export type PinRestrictionKind =
  | 'input-only' // 출력 불가 (예: ESP32 GPIO34–39)
  | 'no-internal-pull' // 내부 풀업/풀다운 없음
  | 'strapping' // 부팅 시 상태가 부팅 모드·설정을 결정
  | 'jtag' // JTAG 디버그 핀
  | 'usb-serial' // USB 시리얼(업로드)과 공유
  | 'adc2-wifi' // Wi-Fi 사용 중 ADC 사용 불가
  | 'onboard-led' // 보드 내장 LED 연결
  | 'interrupt-caveat' // 특정 조건에서 인터럽트 사용 주의

export interface PinRestriction {
  kind: PinRestrictionKind
  description: string
}

export interface BoardPin {
  /** 보드 내 고유 핀 ID (예: "D13", "A0", "5V") */
  id: string
  /** 화면 표시용 라벨 */
  label: string
  group: BoardPinGroup
  capabilities: PinCapability[]
  /** 핀별 주의 사항 (예: A6/A7 은 아날로그 입력 전용) */
  note?: string
  /** 칩의 GPIO 번호 (ESP32 처럼 코드에서 GPIO 번호를 쓰는 보드) */
  gpio?: number
  restrictions?: PinRestriction[]
}

/** 부품 전원 공급에 쓸 수 있는 보드 핀 */
export interface SupplyPin {
  pinId: string
  voltage: number
  note?: string
}

/** 헤더에 노출되지 않았거나 사용하면 안 되는 칩 핀 */
export interface ReservedPin {
  id: string
  label: string
  reason: string
}

/** 보드 그림에 그릴 실제 핀 헤더 한 줄 */
export interface BoardHeader {
  label: string
  side: 'top' | 'bottom'
  pinIds: string[]
}

/** 정보 신뢰도. 확인되지 않은 값을 확정된 사실처럼 표시하지 않기 위해 사용한다. */
export type SpecConfidence = 'official' | 'typical' | 'varies'

export interface ElectricalSpec {
  label: string
  value: string
  confidence: SpecConfidence
  note?: string
}

export interface CommunicationBus {
  kind: 'UART' | 'I2C' | 'SPI'
  /** 버스 이름 (예: "Serial1") */
  name: string
  /** 사용하는 핀 ID와 역할 */
  pins: { role: string; pinId: string }[]
}

/** 코드 생성에 사용할 Arduino 코어 */
export type BoardCore = 'arduino-avr' | 'arduino-esp32'

/** 외부 전원을 받는 보드 핀 (예: Uno VIN 7–12 V) */
export interface BoardPowerInput {
  pinId: string
  minVoltage: number
  maxVoltage: number
}

export interface Board {
  id: string
  name: string
  core: BoardCore
  microcontroller: string
  clockSpeed: string
  /** I/O 논리 전압(V). 저항 계산과 전압 검증에 사용한다. */
  logicVoltage: number
  /** I/O 핀당 권장 최대 전류(mA) */
  ioPinCurrentLimitMa: number
  /** 칩 전체 VCC/GND 전류 한계(mA, 데이터시트 절대 최대 정격) */
  totalCurrentLimitMa: number
  /** Servo 라이브러리 사용 시 analogWrite(PWM)를 쓸 수 없게 되는 핀 */
  servoPwmConflictPins: string[]
  /** GPIO 가 HIGH 로 인식하는 최소 입력 전압(V, VIH min). ATmega: 0.6×VCC, ESP32: 0.75×VDD */
  gpioInputHighMinVoltage: number
  /** GPIO 에 넣을 수 있는 최대 입력 전압(V). 없으면 logicVoltage 로 본다. */
  gpioMaxInputVoltage?: number
  /** 부품 전원 공급용 핀. 없으면 5V(5 V), 3.3V(3.3 V) */
  supplyPins?: SupplyPin[]
  /** GND 핀 ID. 없으면 ["GND"] */
  groundPins?: string[]
  /** 외부 전원을 받는 핀과 허용 전압 */
  powerInput?: BoardPowerInput
  /** 칩에는 있지만 쓸 수 없는 핀 (예: ESP32 플래시용 GPIO6–11) */
  reservedPins?: ReservedPin[]
  /** 실제 헤더 배열. 없으면 핀 그룹(디지털/전원/아날로그)별로 그린다. */
  headers?: BoardHeader[]
  /** 공식 사양에 표기된 디지털 I/O 핀 수 */
  digitalIoCount: number
  /** 공식 사양에 표기된 아날로그 입력 핀 수 */
  analogInputCount: number
  pwmPins: string[]
  interruptPins: string[]
  memory: { flash: string; sram: string; eeprom: string }
  electrical: ElectricalSpec[]
  buses: CommunicationBus[]
  pins: BoardPin[]
  /** 캔버스에서 보드가 차지하는 크기(px) */
  footprint: { width: number; height: number }
  /** 대표 실물 크기 (mm, 위에서 본 가로×세로). 실물 배치 모드에 쓴다 */
  sizeMm?: { width: number; height: number }
  notes: string[]
  sourceUrl: string
}

export type ModuleCategory =
  | 'output'
  | 'input'
  | 'sensor'
  | 'motor'
  | 'driver'
  | 'power'
  | 'actuator'
  | 'display'
  | 'comm'
  | 'interface'

/**
 * 모듈 핀의 전기적 역할
 * - power  : 전원을 받는 핀
 * - source : 전원을 내보내는 핀 (외부 전원 +, 레귤레이터 출력)
 * - load   : 모터 단자. 드라이버 출력에 연결한다 (보드 핀 연결 금지)
 * - drive  : 모터 드라이버 출력. 모터 단자에 연결한다 (보드 핀 연결 금지)
 */
export type ModulePinRole = 'power' | 'ground' | 'signal' | 'passive' | 'source' | 'load' | 'drive'

export interface ModulePin {
  id: string
  name: string
  role: ModulePinRole
  description: string
  /**
   * 이 핀을 보드에 연결할 때 필요한 보드 핀 기능.
   * 전원·GND 처럼 보드 GPIO 가 필요 없는 핀은 빈 배열.
   * 자동 핀 배정과 전기적 검증에 사용한다.
   */
  requires: PinCapability[]
  /** 있으면 좋은 기능 (예: LED → PWM 으로 밝기 조절). 자동 배정 우선순위에만 사용 */
  prefers?: PinCapability[]
  /** 전원 핀의 요구 전압(V). source 핀이면 고정 출력 전압 */
  supplyVoltage?: number
  /** 전원 핀의 허용 전압 범위(V) */
  minVoltage?: number
  maxVoltage?: number
  /** 전원 핀으로 흐르는 전류(mA): 평상시 / 기동·스톨 때 */
  typicalMa?: number
  peakMa?: number
  /** 전류에 곱할 수치 파라미터 (예: LED 개수) */
  scaleParam?: string
  /** 보드 로직 전압에 맞춰 전원을 고른다 (3.3 V 보드에서는 3.3 V) */
  logicSupply?: boolean
  /** 외부 전원 필요 여부. required 면 보드 전원에 자동 연결하지 않는다 */
  external?: 'required' | 'recommended'
  /** source 핀의 출력 전압·최대 전류를 정하는 파라미터 */
  voltageParam?: string
  currentParam?: string
  /** source 핀의 고정 최대 전류(mA) */
  maxCurrentMa?: number
  /** 전선을 여러 가닥 받을 수 있는 단자 (전원 단자대, 드라이버 출력 등) */
  fanout?: boolean
  /** 이 입력 핀이 견디는 최대 신호 전압(V) */
  maxInputVoltage?: number
  /** 보드 쪽에서 본 신호 방향: out = 보드가 출력, in = 보드가 입력, inout = 양방향. 없으면 inout 으로 본다. */
  direction?: 'out' | 'in' | 'inout'
  /** 보드 내부 풀업(INPUT_PULLUP)에 의존하는 입력 */
  pull?: 'up'
  /**
   * 이 선의 HIGH 전압 (부품 출력 또는 부품 쪽 풀업).
   * - 'supply': 부품의 (첫 번째) 전원 핀 전압과 같음 (예: 5 V 로 구동한 HC-SR04 Echo)
   * - { powerPin }: 지정한 전원 핀의 전압과 같음 (예: 레벨 시프터 LV1 = LV 전압)
   * - { fromPin, ratioParam }: 다른 핀 전압 × 비율 (예: 전압 분배기 OUT = IN × 2/3)
   * 3.3 V 보드의 GPIO 에 허용 전압보다 높은 신호가 들어가는지 검사하는 데 사용한다.
   */
  highLevel?: 'supply' | { powerPin: string } | { fromPin: string; ratioParam: string }
}

export interface ModuleParameterOption {
  value: string
  label: string
  /** 옵션에 연결된 수치 (예: LED 색상별 대표 순방향 전압) */
  number?: number
}

/** 인스턴스마다 다르게 설정할 수 있는 값 (예: LED 색상, 목표 전류) */
export interface ModuleParameter {
  id: string
  label: string
  options: ModuleParameterOption[]
  defaultValue: string
  note?: string
  /** 부품 목록(BOM)의 사양에 이 값을 적는다 */
  bom?: boolean
}

/** 드라이버 채널이 받는 모터 종류. servo 는 서보 드라이버(PCA9685 등) 채널 */
export type MotorKind = 'dc' | 'stepper-bipolar' | 'stepper-unipolar' | 'bldc' | 'servo'

/** 모터 사양. 전류는 드라이버 전원 쪽으로 계산한다. */
export interface MotorSpec {
  kind: MotorKind
  minVoltage: number
  maxVoltage: number
  nominalVoltage: number
  typicalMa: number
  peakMa: number
}

/** 모터 드라이버의 한 채널 */
export interface DriverChannel {
  id: string
  label: string
  /** 모터 단자에 연결되는 출력 핀 (모터 load 핀과 같은 순서) */
  outputs: string[]
  /** 보드에서 제어하는 입력 핀. 채널을 쓸 때만 연결하면 된다 */
  inputs: string[]
  accepts: MotorKind[]
}

export interface DriverSpec {
  /** 모터 전원을 받는 핀 */
  supplyPin: string
  /** 드라이버의 전압 강하(V) */
  dropVoltage: number
  /** 채널당 연속·최대 전류(mA) */
  channelMa: number
  channelPeakMa: number
  channels: DriverChannel[]
}

/** 전압 변환 모듈: 출력 핀(source)의 부하가 입력 핀으로 넘어간다 */
export interface RegulatorSpec {
  inputPin: string
  /** 입력은 출력보다 이만큼 높아야 한다(V) */
  dropVoltage: number
}

/** 코드 생성 방식 */
export interface ModuleCode {
  template: string
  /** 코드 식별자 앞부분 (예: motor → motor1) */
  base?: string
  /** 템플릿 역할 → 모듈 핀 ID. 첫 번째 핀으로 코드를 넣을 보드를 정한다 */
  pins?: Record<string, string>
  /** H 브리지 입력 배치 */
  scheme?: 'en-in1-in2' | 'in1-in2'
  /** 평상시 HIGH 로 두어야 하는 대기 핀 */
  standbyPin?: string
  /** LOW 에서 켜지는 출력 */
  activeLow?: boolean
}

export interface Module {
  id: string
  name: string
  /** 영문 이름(검색용) */
  nameEn: string
  category: ModuleCategory
  /** public/ 기준 아이콘 경로 */
  icon: string
  /** 대표 실물 크기 (mm, 위에서 본 가로×세로). 실물 배치 모드에 쓴다 */
  sizeMm?: { width: number; height: number }
  description: string
  pins: ModulePin[]
  parameters?: ModuleParameter[]
  /**
   * 직렬 저항이 필요한 핀 (예: LED 애노드). 저항값은 연결된 보드 핀의 전압과
   * 파라미터(순방향 전압, 목표 전류)로 자동 계산한다.
   */
  seriesResistor?: { pinId: string; forwardVoltageParam: string; currentParam: string }
  /** 대략적인 소비 전류(mA). 전원 예산 검사에 사용하며 모르면 생략 */
  typicalCurrentMa?: number
  /** I²C 장치의 기본 주소 (주소 중복 검사용) */
  i2cAddress?: string
  /** 전원 핀을 보드 5V/3.3V 에 직접 연결했을 때 표시할 경고 */
  boardPowerWarning?: string
  /** 배선만으로 해결되지 않는 설치 작업 (점퍼, 조정 등). 검사에 정보로 표시한다 */
  setupNote?: string
  electrical: ElectricalSpec[]
  /** 검색 보조 키워드 */
  tags: string[]
  /** 주로 사용하는 아두이노 라이브러리 (핀 제약 검사, 코드 생성용) */
  library?: string
  /** 코어별로 다른 라이브러리를 써야 하는 경우 (예: ESP32 → ESP32Servo) */
  libraryByCore?: Partial<Record<BoardCore, string>>
  /** 부품 내부에서 항상 연결된 핀 쌍 (예: 택트 스위치 1A–1B) */
  internalConnections?: [string, string][]
  /** 신호를 그대로 전달하는 핀 쌍 (예: 레벨 시프터 HV1↔LV1, 분배기 IN→OUT). 핀 배정표·코드 생성이 이 경로를 따라간다. */
  passThrough?: [string, string][]
  /** 모터 사양 (모터 부품) */
  motor?: MotorSpec
  /** 드라이버 사양 (모터 드라이버 부품) */
  driver?: DriverSpec
  /** 전압 변환 사양 (벅 컨버터 등) */
  regulator?: RegulatorSpec
  /** 코드 생성 방식 */
  code?: ModuleCode
  notes: string[]
}

export type SupplyKind = 'adapter' | 'battery' | 'usb'

/** 외부 전원 예시 (data/power-supplies.json) */
export interface PowerSupply {
  id: string
  name: string
  kind: SupplyKind
  voltage: number
  maxCurrentMa: number
  /** 배터리 용량(mAh) */
  capacityMah?: number
  note: string
}

/** 작업 공간에 배치된 메인 보드 인스턴스 (보드 정의 Board 와 분리) */
export interface PlacedBoard {
  instanceId: string
  boardId: string
  /** 화면 표시 이름 (예: "보드 1") */
  label: string
  x: number
  y: number
}

/** 작업 공간에 배치된 모듈 인스턴스 */
export interface PlacedModule {
  instanceId: string
  moduleId: string
  /** 같은 모듈을 구분하기 위한 표시 이름 (예: "LED 2") */
  label: string
  x: number
  y: number
  /** 모듈 파라미터 값 (ModuleParameter.id → option value) */
  params: Record<string, string>
  /** 이 부품을 제어하는 보드 인스턴스 (자동 핀 배정·코드 생성 대상) */
  hostBoardId: string
}

/** 전선의 한쪽 끝 */
export type Endpoint =
  | { kind: 'board'; boardInstanceId: string; pinId: string }
  | { kind: 'module'; instanceId: string; pinId: string }

/** 전선 경로: 끝점을 바로 잇거나(direct) 브레드보드를 거친다(breadboard) */
export type RouteMode = 'direct' | 'breadboard'

/**
 * 전선 한 가닥. 핀 배정은 별도로 저장하지 않고 연결 목록에서 계산한다
 * (모듈 핀 → 보드 핀 연결 = 그 모듈 핀의 배정).
 */
/** 한 보드 핀을 함께 쓰는 부품 핀 묶음 (핀 공유). members 는 부품 핀 끝점 키 */
export interface PinShare {
  id: string
  members: string[]
}

export interface Connection {
  id: string
  from: Endpoint
  to: Endpoint
  /** 자동 핀 배정으로 만들어졌는지 여부 */
  auto: boolean
  /** 보드 간 통신 연결(BoardLink)에 속한 전선이면 그 ID */
  linkId?: string
  /** 브레드보드를 거치는 전선이면 'breadboard'. 없으면 직결 */
  via?: 'breadboard'
}

export type BusProtocol = 'UART' | 'I2C' | 'SPI'

/** 보드 간 통신 연결의 한쪽 끝 */
export interface BoardLinkEnd {
  boardInstanceId: string
  /** 버스 이름 (board.buses[].name) 또는 'SoftwareSerial' */
  bus: string
  /** 역할 → 보드 핀 ID (예: { TX: 'D3', RX: 'D2' }) */
  pins: Record<string, string>
}

/**
 * 보드 간 통신. I²C·SPI 는 a 가 컨트롤러, b 가 주변장치이다.
 * pairs 는 서로 이어져야 하는 (a 핀, b 핀) 쌍이며 전선은 connections 에 linkId 로 들어간다.
 */
export interface BoardLink {
  id: string
  protocol: BusProtocol
  a: BoardLinkEnd
  b: BoardLinkEnd
  pairs: { a: string; b: string; signal: string }[]
  /** I²C 주변장치(b) 주소 */
  i2cAddress?: string
  /** UART 통신 속도 */
  baud?: number
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'board'; boardInstanceId: string }
  | { kind: 'module'; instanceId: string }
  | { kind: 'connection'; connectionId: string }
  | { kind: 'breadboard' }

export interface Point {
  x: number
  y: number
}
