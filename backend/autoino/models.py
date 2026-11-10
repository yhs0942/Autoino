"""데이터 모델 (pydantic v2).

필드 이름은 파이썬 스타일(snake_case)이며 JSON 에서는 프런트엔드와 같은 camelCase 를 쓴다.
부품·보드 정의는 data/*.json 과 같은 구조이고, 회로 문서는 프로젝트 파일(.autoino.json) 버전 2 구조이다.
"""

from __future__ import annotations

from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

PinCapability = Literal[
    "digital", "analog", "pwm", "interrupt", "i2c-sda", "i2c-scl", "spi-mosi", "spi-miso", "spi-sck",
    "spi-ss", "uart-rx", "uart-tx", "dac", "touch",
]
BoardPinGroup = Literal["digital", "analog", "power", "control"]
PinRestrictionKind = Literal[
    "input-only", "no-internal-pull", "strapping", "jtag", "usb-serial", "adc2-wifi", "onboard-led", "interrupt-caveat",
]
SpecConfidence = Literal["official", "typical", "varies"]
ModuleCategory = Literal["output", "input", "sensor", "motor", "driver", "power", "actuator", "display", "comm", "interface"]
ModulePinRole = Literal["power", "ground", "signal", "passive", "source", "load", "drive"]
MotorKind = Literal["dc", "stepper-bipolar", "stepper-unipolar", "bldc", "servo"]
BoardCore = Literal["arduino-avr", "arduino-esp32"]
BusProtocol = Literal["UART", "I2C", "SPI"]


class Model(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid", frozen=False)

    def dump(self) -> dict:
        return self.model_dump(by_alias=True, exclude_none=True)


# ---------------------------------------------------------------- 보드 정의


class PinRestriction(Model):
    kind: PinRestrictionKind
    description: str


class BoardPin(Model):
    id: str
    label: str
    group: BoardPinGroup
    capabilities: list[PinCapability]
    note: str | None = None
    gpio: int | None = None
    restrictions: list[PinRestriction] | None = None


class SupplyPin(Model):
    pin_id: str
    voltage: float
    note: str | None = None


class ReservedPin(Model):
    id: str
    label: str
    reason: str


class BoardHeader(Model):
    label: str
    side: Literal["top", "bottom"]
    pin_ids: list[str]


class ElectricalSpec(Model):
    label: str
    value: str
    confidence: SpecConfidence
    note: str | None = None


class BusPin(Model):
    role: str
    pin_id: str


class CommunicationBus(Model):
    kind: BusProtocol
    name: str
    pins: list[BusPin]


class Memory(Model):
    flash: str
    sram: str
    eeprom: str


class Footprint(Model):
    width: float
    height: float


class BoardPowerInput(Model):
    pin_id: str
    min_voltage: float
    max_voltage: float


class Board(Model):
    id: str
    name: str
    core: BoardCore
    logic_voltage: float
    io_pin_current_limit_ma: float
    total_current_limit_ma: float
    servo_pwm_conflict_pins: list[str]
    gpio_input_high_min_voltage: float
    gpio_max_input_voltage: float | None = None
    supply_pins: list[SupplyPin] | None = None
    ground_pins: list[str] | None = None
    power_input: BoardPowerInput | None = None
    reserved_pins: list[ReservedPin] | None = None
    headers: list[BoardHeader] | None = None
    microcontroller: str
    clock_speed: str
    digital_io_count: int
    analog_input_count: int
    pwm_pins: list[str]
    interrupt_pins: list[str]
    memory: Memory
    electrical: list[ElectricalSpec]
    buses: list[CommunicationBus]
    pins: list[BoardPin]
    footprint: Footprint
    #: 대표 실물 크기 (mm). 실물 배치 모드에 쓴다
    size_mm: Footprint | None = None
    notes: list[str]
    source_url: str

    def pin(self, pin_id: str) -> BoardPin | None:
        return next((p for p in self.pins if p.id == pin_id), None)


# ---------------------------------------------------------------- 모듈(부품) 정의


class PowerPinLevel(Model):
    power_pin: str


class DerivedLevel(Model):
    from_pin: str
    ratio_param: str


class ModulePin(Model):
    id: str
    name: str
    role: ModulePinRole
    description: str
    requires: list[PinCapability]
    prefers: list[PinCapability] | None = None
    supply_voltage: float | None = None
    min_voltage: float | None = None
    max_voltage: float | None = None
    typical_ma: float | None = None
    peak_ma: float | None = None
    scale_param: str | None = None
    logic_supply: bool | None = None
    external: Literal["required", "recommended"] | None = None
    voltage_param: str | None = None
    current_param: str | None = None
    max_current_ma: float | None = None
    fanout: bool | None = None
    max_input_voltage: float | None = None
    direction: Literal["out", "in", "inout"] | None = None
    pull: Literal["up"] | None = None
    high_level: Union[Literal["supply"], PowerPinLevel, DerivedLevel, None] = None


class ParameterOption(Model):
    value: str
    label: str
    number: float | None = None


class ModuleParameter(Model):
    id: str
    label: str
    options: list[ParameterOption]
    default_value: str
    note: str | None = None
    bom: bool | None = None


class SeriesResistorSpec(Model):
    pin_id: str
    forward_voltage_param: str
    current_param: str


class MotorSpec(Model):
    kind: MotorKind
    min_voltage: float
    max_voltage: float
    nominal_voltage: float
    typical_ma: float
    peak_ma: float


class DriverChannel(Model):
    id: str
    label: str
    outputs: list[str]
    inputs: list[str]
    accepts: list[MotorKind]


class DriverSpec(Model):
    supply_pin: str
    drop_voltage: float
    channel_ma: float
    channel_peak_ma: float
    channels: list[DriverChannel]


class RegulatorSpec(Model):
    input_pin: str
    drop_voltage: float


class ModuleCode(Model):
    template: str
    base: str | None = None
    pins: dict[str, str] | None = None
    scheme: Literal["en-in1-in2", "in1-in2"] | None = None
    standby_pin: str | None = None
    active_low: bool | None = None


class PowerSupply(Model):
    id: str
    name: str
    kind: Literal["adapter", "battery", "usb"]
    voltage: float
    max_current_ma: float
    capacity_mah: float | None = None
    note: str


class MuxSpec(Model):
    """아날로그 멀티플렉서: 선택선으로 고른 채널이 공통 핀에 이어진다"""

    common: str
    select: list[str]
    channels: list[str]


class Module(Model):
    id: str
    name: str
    name_en: str
    category: ModuleCategory
    icon: str
    #: 대표 실물 크기 (mm). 실물 배치 모드에 쓴다
    size_mm: Footprint | None = None
    description: str
    pins: list[ModulePin]
    parameters: list[ModuleParameter] | None = None
    series_resistor: SeriesResistorSpec | None = None
    typical_current_ma: float | None = None
    i2c_address: str | None = Field(default=None, alias="i2cAddress")
    board_power_warning: str | None = None
    setup_note: str | None = None
    electrical: list[ElectricalSpec]
    tags: list[str]
    library: str | None = None
    library_by_core: dict[BoardCore, str] | None = None
    internal_connections: list[tuple[str, str]] | None = None
    pass_through: list[tuple[str, str]] | None = None
    mux: MuxSpec | None = None
    motor: MotorSpec | None = None
    driver: DriverSpec | None = None
    regulator: RegulatorSpec | None = None
    code: ModuleCode | None = None
    notes: list[str]

    def pin(self, pin_id: str) -> ModulePin | None:
        return next((p for p in self.pins if p.id == pin_id), None)

    def library_for(self, core: BoardCore) -> str | None:
        return (self.library_by_core or {}).get(core, self.library)


# ---------------------------------------------------------------- 회로 문서


class Lenient(Model):
    """프로젝트 파일 모델 (알 수 없는 필드는 무시)"""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class PlacedBoard(Lenient):
    instance_id: str
    board_id: str
    label: str
    x: float
    y: float


class PlacedModule(Lenient):
    instance_id: str
    module_id: str
    label: str
    x: float
    y: float
    params: dict[str, str]
    host_board_id: str


class BoardEndpoint(Lenient):
    kind: Literal["board"]
    board_instance_id: str
    pin_id: str


class ModuleEndpoint(Lenient):
    kind: Literal["module"]
    instance_id: str
    pin_id: str


Endpoint = Union[BoardEndpoint, ModuleEndpoint]


class Connection(Lenient):
    id: str
    from_: Endpoint = Field(alias="from", discriminator="kind")
    to: Endpoint = Field(discriminator="kind")
    auto: bool
    link_id: str | None = None
    via: Literal["breadboard"] | None = None


class BoardLinkEnd(Lenient):
    board_instance_id: str
    bus: str
    pins: dict[str, str]


class LinkPair(Lenient):
    a: str
    b: str
    signal: str


class BoardLink(Lenient):
    id: str
    protocol: BusProtocol
    a: BoardLinkEnd
    b: BoardLinkEnd
    pairs: list[LinkPair]
    i2c_address: str | None = Field(default=None, alias="i2cAddress")
    baud: int | None = None


class Position(Lenient):
    x: float
    y: float


class PinShare(Lenient):
    """한 보드 핀을 함께 쓰는 부품 핀 묶음 (핀 공유). members 는 부품 핀 끝점 키"""

    id: str
    members: list[str]


class ProjectData(Lenient):
    name: str
    boards: list[PlacedBoard]
    placed: list[PlacedModule]
    connections: list[Connection]
    links: list[BoardLink]
    breadboard: Position | None = None
    breadboard_holes: dict[str, str] | None = None
    shares: list[PinShare] | None = None
    #: 실물 배치 모드의 위치 (보드·부품 인스턴스 ID 또는 'breadboard' → 좌표)
    layout: dict[str, Position] | None = None
    next_seq: int
    next_conn_seq: int
    next_board_seq: int
    next_link_seq: int
    label_counters: dict[str, int]
