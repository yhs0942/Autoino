import { motorLibraries } from './libsMotion'
import { BOOL, CSTR, F32, I16, STRING, U16, U32, U8, VOID, convert, intOf, longOf, truthy, type CType, type Platform } from './ctypes'
import { printBytes, printMethods, streamMethods, waitFor, waitUntil, type BoardInfo } from './core'
import { NOOP_HEADERS } from './lexer'
import type { ClassDef, Gen, LcdDevice, Machine, MethodDef, OledDevice, Registry, SerialPort } from './machine'
import { Ptr, RuntimeErr, cstrText, fromUtf8, utf8 } from './values'

// 라이브러리: #include 한 헤더에 따라 클래스·객체·상수를 더한다.
// 하드웨어와 맞닿는 부분은 Host 를 통해 배선된 부품에 전달한다.

export interface LibSet {
  registry: Partial<Registry> & Pick<Registry, 'functions' | 'constants' | 'classes' | 'objects' | 'types'>
  unknown: string[]
  notes: { header: string; message: string }[]
}

export const struct = (name: string, fields: [string, CType][]): CType & { k: 'struct' } => ({ k: 'struct', name, fields: fields.map(([n, type]) => ({ name: n, type })) })
export const arr = (of: CType, len: number): CType => ({ k: 'array', of, len })

type Lib = (r: LibSet['registry'], board: BoardInfo, p: Platform) => void

const UNSUPPORTED: Record<string, string> = {
  'WiFi.h': 'Wi-Fi 는 시뮬레이션할 수 없습니다. Wi-Fi 부분을 빼고 실행해 보세요',
  'WiFiClient.h': 'Wi-Fi 는 시뮬레이션할 수 없습니다',
  'WebServer.h': '웹 서버는 시뮬레이션할 수 없습니다',
  'ESP8266WiFi.h': 'ESP8266 은 지원하지 않습니다',
  'HTTPClient.h': '네트워크 기능은 시뮬레이션할 수 없습니다',
  'PubSubClient.h': 'MQTT(네트워크)는 시뮬레이션할 수 없습니다',
  'BluetoothSerial.h': 'ESP32 내장 블루투스는 시뮬레이션할 수 없습니다. HC-05 모듈을 SoftwareSerial/Serial2 로 쓰세요',
  'BLEDevice.h': 'BLE 는 시뮬레이션할 수 없습니다',
  'LiquidCrystal.h': '병렬 LCD 부품이 없습니다. I²C LCD 는 LiquidCrystal_I2C.h 를 쓰세요',
  'U8g2lib.h': 'OLED 는 Adafruit_SSD1306 라이브러리로 시뮬레이션합니다 (#include <Adafruit_SSD1306.h>)',
  'U8x8lib.h': 'OLED 는 Adafruit_SSD1306 라이브러리로 시뮬레이션합니다',
  'IRremote.h': '적외선 리모컨 부품이 없습니다',
  'Keypad.h': '키패드 부품이 없습니다',
}

/** 헤더 → 같이 들어오는 헤더 */
const DEPS: Record<string, string[]> = {
  'LiquidCrystal_I2C.h': ['Wire.h'],
  'Adafruit_SSD1306.h': ['Wire.h', 'Adafruit_GFX.h', 'SPI.h'],
  'Adafruit_PWMServoDriver.h': ['Wire.h'],
  'Adafruit_MPU6050.h': ['Wire.h', 'Adafruit_Sensor.h'],
  'MPU6050.h': ['Wire.h'],
  'MFRC522.h': ['SPI.h'],
}

export function libraryRegistry(headers: string[], board: BoardInfo, p: Platform): LibSet {
  const set: LibSet = { registry: { functions: new Map(), constants: new Map(), classes: new Map(), objects: new Map(), types: new Map() }, unknown: [], notes: [] }
  const all = new Set<string>()
  const add = (h: string) => {
    if (all.has(h)) return
    all.add(h)
    for (const d of DEPS[h] ?? []) add(d)
  }
  headers.forEach(add)
  const libs = { ...LIBS, ...motorLibraries }
  for (const h of all) {
    if (NOOP_HEADERS.has(h) || NOOP_LIBS.has(h)) continue
    const lib = libs[h]
    if (lib) lib(set.registry, board, p)
    else if (UNSUPPORTED[h]) set.unknown.push(`${h} — ${UNSUPPORTED[h]}`)
    else set.unknown.push(`${h} (지원: ${Object.keys(libs).filter((k) => !k.startsWith('_')).join(', ')})`)
  }
  if (all.has('Servo.h') && board.core === 'esp32') set.notes.push({ header: 'Servo.h', message: 'ESP32 에서는 Servo.h 대신 ESP32Servo.h 를 써야 컴파일됩니다 (시뮬레이션은 그대로 합니다)' })
  return set
}

const NOOP_LIBS = new Set(['Adafruit_GFX.h', 'Adafruit_Sensor.h', 'I2Cdev.h', 'Adafruit_I2CDevice.h', 'Adafruit_BusIO_Register.h', 'avr/wdt.h_', 'Arduino.h'])

const num = (r: LibSet['registry'], name: string, v: number, t: CType = U8) => r.constants.set(name, { t, v })

// ------------------------------------------------------------ Servo

interface ServoObj {
  pin: string | null
  min: number
  max: number
  us: number
}

const servoLib: Lib = (r) => {
  const int = (p: Platform) => intOf(p)
  const write = (m: Machine, s: ServoObj, us: number) => {
    s.us = Math.round(Math.max(s.min, Math.min(s.max, us)))
    if (s.pin) m.host.servo(s.pin, s.us, m.us)
  }
  const methods: Record<string, MethodDef> = {
    attach: {
      ret: U8,
      min: 1,
      max: 3,
      call: (m, self, a) => {
        const s = self as ServoObj
        const id = m.host.pinId(Number(a[0]))
        if (!id) {
          m.warn(`Servo.attach(${Number(a[0])}): 보드에 없는 핀입니다`)
          return 0
        }
        if (a.length >= 3) {
          s.min = Number(a[1])
          s.max = Number(a[2])
        }
        s.pin = id
        m.host.pinMode(id, 'OUTPUT', m.us)
        m.state.servoAttached = true
        m.host.servo(id, s.us, m.us)
        return 1
      },
    },
    detach: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const s = self as ServoObj
        if (s.pin) m.host.servo(s.pin, null, m.us)
        s.pin = null
      },
    },
    write: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (m, self, a) => {
        const s = self as ServoObj
        let v = Number(a[0])
        // 200 보다 작으면 각도, 크면 마이크로초
        if (v < 200) {
          v = Math.max(0, Math.min(180, v))
          v = s.min + ((s.max - s.min) * v) / 180
        }
        write(m, s, v)
      },
    },
    writeMicroseconds: { ret: VOID, min: 1, max: 1, call: (m, self, a) => write(m, self as ServoObj, Number(a[0])) },
    read: {
      ret: (_t, p) => int(p),
      max: 0,
      call: (_m, self) => {
        const s = self as ServoObj
        return Math.trunc(((s.us + 1 - s.min) * 180) / (s.max - s.min))
      },
    },
    readMicroseconds: { ret: (_t, p) => int(p), max: 0, call: (_m, self) => (self as ServoObj).us },
    attached: { ret: BOOL, max: 0, call: (_m, self) => ((self as ServoObj).pin ? 1 : 0) },
    setPeriodHertz: { ret: VOID, min: 1, max: 1, call: () => undefined },
  }
  r.classes.set('Servo', { name: 'Servo', header: 'Servo.h', ctorMax: 0, construct: () => ({ pin: null, min: 544, max: 2400, us: 1500 }) satisfies ServoObj, methods })
  num(r, 'MIN_PULSE_WIDTH', 544, U16)
  num(r, 'MAX_PULSE_WIDTH', 2400, U16)
  num(r, 'DEFAULT_PULSE_WIDTH', 1500, U16)
}

// ------------------------------------------------------------ Wire (I²C)

interface WireObj {
  begun: boolean
  slave: number | null
  tx: number[]
  txAddr: number
  rx: number[]
  rxPos: number
  /** onRequest 안에서 write 하면 응답에 쌓인다 */
  reply: number[] | null
  onReceive: { invoke?: (args?: unknown[]) => void } | null
  onRequest: { invoke?: (args?: unknown[]) => void } | null
  timeout: number
}

const I2C_BYTE_US = 90

const wireLib: Lib = (r, board) => {
  const wireMethods: Record<string, MethodDef> = {
    begin: {
      ret: BOOL,
      max: 3,
      call: (m, self, a) => {
        const w = self as WireObj
        w.begun = true
        // Wire.begin(주소) → 주변장치(슬레이브), ESP32 Wire.begin(SDA, SCL[, 주파수]) → 컨트롤러
        const slave = a.length === 1 || (a.length >= 1 && board.core === 'avr') ? Number(a[0]) : null
        w.slave = slave
        m.host.i2cBegin(slave, {
          receive: (bytes) => {
            w.rx = bytes
            w.rxPos = 0
            w.onReceive?.invoke?.([bytes.length])
          },
          request: () => {
            w.reply = []
            try {
              w.onRequest?.invoke?.([])
              return w.reply
            } finally {
              w.reply = null
            }
          },
        })
        return 1
      },
    },
    end: { ret: VOID, max: 0, call: (_m, self) => void ((self as WireObj).begun = false) },
    setClock: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setTimeout: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setWireTimeout: { ret: VOID, max: 2, call: () => undefined },
    beginTransmission: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (m, self, a) => {
        const w = self as WireObj
        if (!w.begun) m.warn('Wire.begin() 을 먼저 불러야 I²C 를 쓸 수 있습니다')
        w.txAddr = Number(a[0]) & 0x7f
        w.tx = []
      },
    },
    endTransmission: {
      ret: U8,
      max: 1,
      call: (m, self) => {
        const w = self as WireObj
        m.us += (w.tx.length + 1) * I2C_BYTE_US
        if (!w.begun) return 4
        return m.host.i2cWrite(w.txAddr, w.tx, m.us)
      },
    },
    requestFrom: {
      ret: U8,
      min: 2,
      max: 3,
      call: (m, self, a) => {
        const w = self as WireObj
        const n = Math.min(32, Number(a[1]))
        m.us += (n + 1) * I2C_BYTE_US
        w.rx = w.begun ? m.host.i2cRead(Number(a[0]) & 0x7f, n, m.us) : []
        w.rxPos = 0
        return w.rx.length
      },
    },
    write: {
      ret: U32,
      min: 1,
      max: 2,
      call: (_m, self, a, t) => {
        const w = self as WireObj
        const bytes = a.length >= 2 ? ((a[0] instanceof Ptr ? (a[0].a as number[]).slice(a[0].i as number) : (a[0] as number[])) ?? []).slice(0, Number(a[1])).map((b) => Number(b) & 255) : t[0].k === 'int' || t[0].k === 'float' ? [Number(a[0]) & 255] : utf8(cstrText(a[0]))
        if (w.reply) w.reply.push(...bytes)
        else w.tx.push(...bytes)
        return bytes.length
      },
    },
    print: {
      ret: U32,
      min: 1,
      max: 2,
      call: (_m, self, a, t) => {
        const w = self as WireObj
        const bytes = printBytes(a, t, false)
        if (w.reply) w.reply.push(...bytes)
        else w.tx.push(...bytes)
        return bytes.length
      },
    },
    available: { ret: (_t, p) => intOf(p), max: 0, call: (_m, self) => (self as WireObj).rx.length - (self as WireObj).rxPos },
    read: {
      ret: (_t, p) => intOf(p),
      max: 0,
      call: (_m, self) => {
        const w = self as WireObj
        return w.rxPos < w.rx.length ? w.rx[w.rxPos++] : -1
      },
    },
    peek: { ret: (_t, p) => intOf(p), max: 0, call: (_m, self) => ((self as WireObj).rx[(self as WireObj).rxPos] ?? -1) },
    onReceive: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as WireObj).onReceive = a[0] as WireObj['onReceive']) },
    onRequest: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as WireObj).onRequest = a[0] as WireObj['onRequest']) },
  }
  r.classes.set('TwoWire', { name: 'TwoWire', header: 'Wire.h', construct: () => ({}), methods: wireMethods })
  const make = (): WireObj => ({ begun: false, slave: null, tx: [], txAddr: 0, rx: [], rxPos: 0, reply: null, onReceive: null, onRequest: null, timeout: 1000 })
  r.objects.set('Wire', { cls: 'TwoWire', make })
  if (board.core === 'esp32') r.objects.set('Wire1', { cls: 'TwoWire', make })
}

// ------------------------------------------------------------ SPI

const spiLib: Lib = (r, board) => {
  r.classes.set('SPISettings', { name: 'SPISettings', header: 'SPI.h', ctorMax: 3, construct: () => ({}), methods: {} })
  const methods: Record<string, MethodDef> = {
    begin: { ret: VOID, max: 4, call: (m) => void (m.state.spiBegun = true) },
    end: { ret: VOID, max: 0, call: () => undefined },
    beginTransaction: { ret: VOID, min: 1, max: 1, call: () => undefined },
    endTransaction: { ret: VOID, max: 0, call: () => undefined },
    setBitOrder: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setDataMode: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setClockDivider: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setFrequency: { ret: VOID, min: 1, max: 1, call: () => undefined },
    transfer: {
      ret: U8,
      min: 1,
      max: 2,
      call: (m, _self, a) => {
        if (!m.state.spiBegun) m.warn('SPI.begin() 을 먼저 불러야 합니다')
        m.us += 2
        if (Array.isArray(a[0])) {
          const buf = a[0] as number[]
          for (let i = 0; i < Number(a[1] ?? buf.length); i++) buf[i] = m.host.spiTransfer(Number(buf[i]) & 255, m.us)
          return 0
        }
        return m.host.spiTransfer(Number(a[0]) & 255, m.us)
      },
    },
    transfer16: {
      ret: U16,
      min: 1,
      max: 1,
      call: (m, _self, a) => {
        const v = Number(a[0])
        const hi = m.host.spiTransfer((v >> 8) & 255, m.us)
        const lo = m.host.spiTransfer(v & 255, m.us)
        return (hi << 8) | lo
      },
    },
  }
  r.classes.set('SPIClass', { name: 'SPIClass', header: 'SPI.h', construct: () => ({}), methods })
  r.objects.set('SPI', { cls: 'SPIClass', make: () => ({}) })
  for (const [k, v] of [['SPI_MODE0', 0], ['SPI_MODE1', 4], ['SPI_MODE2', 8], ['SPI_MODE3', 12], ['SPI_CLOCK_DIV2', 4], ['SPI_CLOCK_DIV4', 0], ['SPI_CLOCK_DIV8', 5], ['SPI_CLOCK_DIV16', 1], ['SPI_CLOCK_DIV32', 6], ['SPI_CLOCK_DIV64', 2], ['SPI_CLOCK_DIV128', 3]] as [string, number][])
    num(r, k, v)
  if (board.core === 'avr') {
    for (const [k, v] of [['SPE', 6], ['SPIE', 7], ['MSTR', 4], ['SPIF', 7], ['CPOL', 3], ['CPHA', 2], ['DORD', 5], ['SPR0', 0], ['SPR1', 1]] as [string, number][]) num(r, k, v)
    // SPI 주변장치(슬레이브) 코드가 쓰는 AVR 레지스터
    r.globals ??= new Map()
    for (const name of ['SPCR', 'SPDR', 'SPSR']) r.globals.set(name, { t: U8, v: 0 })
  }
}

// ------------------------------------------------------------ LiquidCrystal_I2C

interface LcdObj {
  dev: LcdDevice
  attached: boolean
  addr: number
  /** DDRAM 2줄 × 40칸 */
  ddram: number[][]
  col: number
  line: number
  shift: number
  custom: Map<number, number[]>
  begun: boolean
}

function lcdRefresh(o: LcdObj) {
  const { dev } = o
  for (let r = 0; r < dev.rows; r++) {
    const line = o.ddram[r % 2]
    const base = r >= 2 ? dev.cols : 0
    const row: string[] = []
    for (let c = 0; c < dev.cols; c++) {
      const code = line[(base + c + o.shift + 40) % 40]
      row.push(lcdGlyph(code, o.custom))
    }
    dev.chars[r] = row
  }
}

/** HD44780 문자 (ASCII 범위만 그대로, 0–7 은 사용자 글자) */
function lcdGlyph(code: number, custom: Map<number, number[]>): string {
  if (code < 16) return custom.has(code & 7) ? `\u0000${code & 7}` : ' '
  if (code === 0x7e) return '→'
  if (code === 0x7f) return '←'
  if (code === 0xdf) return '°'
  if (code === 0xff) return '█'
  if (code >= 32 && code < 126) return String.fromCharCode(code)
  return '▒'
}

const lcdLib: Lib = (r) => {
  const put = (m: Machine, o: LcdObj, bytes: number[]) => {
    if (!o.begun) m.warn('LCD 를 쓰기 전에 lcd.init() (또는 lcd.begin()) 을 불러야 합니다')
    for (const b of bytes) {
      if ((b === 13 || b === 10) && !o.custom.has(b & 7)) m.warn('LCD 에 println 을 쓰면 줄이 바뀌지 않고 이상한 글자 2개가 찍힙니다. setCursor(0, 1) 로 줄을 옮기세요')
      o.ddram[o.line][o.col] = b
      o.col++
      if (o.col >= 40) {
        o.col = 0
        o.line = (o.line + 1) % 2
      }
      m.us += 4 * I2C_BYTE_US
    }
    lcdRefresh(o)
  }
  const blank = () => [Array(40).fill(32), Array(40).fill(32)]
  const methods: Record<string, MethodDef> = {
    init: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as LcdObj
        o.begun = true
        o.ddram = blank()
        o.col = 0
        o.line = 0
        o.dev.on = true
        if (!o.attached) m.warn(`I²C 주소 0x${o.addr.toString(16).toUpperCase()} 에 LCD 가 없습니다 (배선·주소를 확인하세요)`)
        m.us += 50000
        lcdRefresh(o)
      },
    },
    clear: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as LcdObj
        o.ddram = blank()
        o.col = 0
        o.line = 0
        o.shift = 0
        m.us += 2000
        lcdRefresh(o)
      },
    },
    home: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as LcdObj
        o.col = 0
        o.line = 0
        o.shift = 0
        m.us += 2000
        lcdRefresh(o)
      },
    },
    setCursor: {
      ret: VOID,
      min: 2,
      max: 2,
      call: (_m, self, a) => {
        const o = self as LcdObj
        const row = Math.max(0, Math.min(o.dev.rows - 1, Number(a[1])))
        o.line = row % 2
        o.col = ((row >= 2 ? o.dev.cols : 0) + Number(a[0])) % 40
      },
    },
    backlight: { ret: VOID, max: 0, call: (_m, self) => void ((self as LcdObj).dev.backlight = true) },
    noBacklight: { ret: VOID, max: 0, call: (_m, self) => void ((self as LcdObj).dev.backlight = false) },
    setBacklight: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as LcdObj).dev.backlight = truthy(a[0])) },
    display: { ret: VOID, max: 0, call: (_m, self) => void ((self as LcdObj).dev.on = true) },
    noDisplay: { ret: VOID, max: 0, call: (_m, self) => void ((self as LcdObj).dev.on = false) },
    cursor: { ret: VOID, max: 0, call: () => undefined },
    noCursor: { ret: VOID, max: 0, call: () => undefined },
    blink: { ret: VOID, max: 0, call: () => undefined },
    noBlink: { ret: VOID, max: 0, call: () => undefined },
    leftToRight: { ret: VOID, max: 0, call: () => undefined },
    rightToLeft: { ret: VOID, max: 0, call: () => undefined },
    autoscroll: { ret: VOID, max: 0, call: () => undefined },
    noAutoscroll: { ret: VOID, max: 0, call: () => undefined },
    scrollDisplayLeft: {
      ret: VOID,
      max: 0,
      call: (_m, self) => {
        const o = self as LcdObj
        o.shift = (o.shift + 1) % 40
        lcdRefresh(o)
      },
    },
    scrollDisplayRight: {
      ret: VOID,
      max: 0,
      call: (_m, self) => {
        const o = self as LcdObj
        o.shift = (o.shift + 39) % 40
        lcdRefresh(o)
      },
    },
    createChar: {
      ret: VOID,
      min: 2,
      max: 2,
      call: (_m, self, a) => {
        const o = self as LcdObj
        const src = a[1] instanceof Ptr ? (a[1].a as number[]) : (a[1] as number[])
        o.custom.set(Number(a[0]) & 7, Array.isArray(src) ? src.slice(0, 8).map(Number) : [])
        lcdRefresh(o)
      },
    },
    ...printMethods((self, m, bytes) => put(m, self as LcdObj, bytes)),
  }
  methods.begin = { ret: VOID, max: 3, call: methods.init.call }
  r.classes.set('LiquidCrystal_I2C', {
    name: 'LiquidCrystal_I2C',
    header: 'LiquidCrystal_I2C.h',
    ctorMin: 3,
    ctorMax: 3,
    construct: (m, a) => {
      const addr = Number(a[0])
      const cols = Number(a[1])
      const rows = Number(a[2])
      const dev = m.host.lcd(addr)
      const attached = !!dev
      const d: LcdDevice = dev ?? { cols, rows, chars: [], backlight: false, on: false }
      d.cols = cols
      d.rows = rows
      const o: LcdObj = { dev: d, attached, addr, ddram: blank(), col: 0, line: 0, shift: 0, custom: new Map(), begun: false }
      ;(d as LcdDevice & { custom?: Map<number, number[]> }).custom = o.custom
      lcdRefresh(o)
      return o
    },
    methods,
  })
}

// ------------------------------------------------------------ Adafruit SSD1306

interface OledObj {
  dev: OledDevice
  attached: boolean
  width: number
  height: number
  buf: Uint8Array
  texts: OledDevice['texts']
  cx: number
  cy: number
  size: number
  color: number
  bg: number | null
  wrap: boolean
  begun: boolean
}

const oledLib: Lib = (r) => {
  const px = (o: OledObj, x: number, y: number, c: number) => {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0 || x >= o.width || y >= o.height) return
    const i = y * o.width + x
    o.buf[i] = c === 2 ? o.buf[i] ^ 1 : c ? 1 : 0
  }
  const clearTexts = (o: OledObj, x: number, y: number, w: number, h: number) => {
    o.texts = o.texts.filter((t) => {
      const tw = t.text.length * 6 * t.size
      const th = 8 * t.size
      return t.x + tw <= x || t.x >= x + w || t.y + th <= y || t.y >= y + h
    })
  }
  const fillRect = (o: OledObj, x: number, y: number, w: number, h: number, c: number) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(o, x + i, y + j, c)
    if (c === 0) clearTexts(o, x, y, w, h)
  }
  const line = (o: OledObj, x0: number, y0: number, x1: number, y1: number, c: number) => {
    x0 = Math.round(x0)
    y0 = Math.round(y0)
    x1 = Math.round(x1)
    y1 = Math.round(y1)
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (let n = 0; n < 1000; n++) {
      px(o, x0, y0, c)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x0 += sx
      }
      if (e2 <= dx) {
        err += dx
        y0 += sy
      }
    }
  }
  const circle = (o: OledObj, x0: number, y0: number, rad: number, c: number, fill: boolean) => {
    for (let y = -rad; y <= rad; y++)
      for (let x = -rad; x <= rad; x++) {
        const d = x * x + y * y
        if (fill ? d <= rad * rad + rad : Math.abs(Math.sqrt(d) - rad) < 0.5) px(o, x0 + x, y0 + y, c)
      }
  }
  const triangle = (o: OledObj, pts: number[], c: number, fill: boolean) => {
    const [x0, y0, x1, y1, x2, y2] = pts
    if (!fill) {
      line(o, x0, y0, x1, y1, c)
      line(o, x1, y1, x2, y2, c)
      line(o, x2, y2, x0, y0, c)
      return
    }
    const minX = Math.min(x0, x1, x2)
    const maxX = Math.max(x0, x1, x2)
    const minY = Math.min(y0, y1, y2)
    const maxY = Math.max(y0, y1, y2)
    const area = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const a = area(x0, y0, x1, y1, x, y)
        const b = area(x1, y1, x2, y2, x, y)
        const d = area(x2, y2, x0, y0, x, y)
        if ((a >= 0 && b >= 0 && d >= 0) || (a <= 0 && b <= 0 && d <= 0)) px(o, x, y, c)
      }
  }
  const text = (m: Machine, o: OledObj, bytes: number[]) => {
    if (!o.begun) m.warn('display.begin(SSD1306_SWITCHCAPVCC, 0x3C) 를 먼저 불러야 OLED 가 켜집니다')
    const s = fromUtf8(bytes)
    let run = ''
    let rx = o.cx
    let ry = o.cy
    const flush = () => {
      if (!run) return
      if (o.bg !== null) clearTexts(o, rx, ry, run.length * 6 * o.size, 8 * o.size)
      o.texts.push({ x: rx, y: ry, size: o.size, text: run, color: o.color, bg: o.bg })
      if (o.bg !== null) for (let j = 0; j < 8 * o.size; j++) for (let i = 0; i < run.length * 6 * o.size; i++) px(o, rx + i, ry + j, o.bg)
      run = ''
    }
    for (const ch of s) {
      if (ch === '\n') {
        flush()
        o.cx = 0
        o.cy += 8 * o.size
        rx = o.cx
        ry = o.cy
        continue
      }
      if (ch === '\r') continue
      if (o.wrap && o.cx + 6 * o.size > o.width) {
        flush()
        o.cx = 0
        o.cy += 8 * o.size
        rx = o.cx
        ry = o.cy
      }
      run += ch
      o.cx += 6 * o.size
    }
    flush()
  }
  const P = (n: number): MethodDef['call'] => {
    void n
    return undefined
  }
  void P
  const m4 = (f: (o: OledObj, a: number[]) => void, min: number, max = min): MethodDef => ({ ret: VOID, min, max, call: (_m, self, a) => f(self as OledObj, a.map(Number)) })
  const methods: Record<string, MethodDef> = {
    begin: {
      ret: BOOL,
      max: 4,
      call: (m, self, a) => {
        const o = self as OledObj
        const addr = a.length >= 2 ? Number(a[1]) : 0x3c
        const dev = m.host.oled(addr)
        if (dev) {
          o.dev = dev
          o.attached = true
        } else o.attached = false
        o.dev.width = o.width
        o.dev.height = o.height
        o.begun = true
        o.dev.on = !!dev
        m.us += 30000
        if (!dev) m.warn(`I²C 주소 0x${addr.toString(16).toUpperCase()} 에 OLED 가 없습니다 (배선·주소를 확인하세요)`)
        return dev ? 1 : 0
      },
    },
    clearDisplay: {
      ret: VOID,
      max: 0,
      call: (_m, self) => {
        const o = self as OledObj
        o.buf.fill(0)
        o.texts = []
      },
    },
    display: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as OledObj
        o.dev.pixels = o.buf.slice()
        o.dev.texts = o.texts.slice()
        o.dev.frame++
        m.us += 25000
      },
    },
    drawPixel: m4((o, a) => px(o, a[0], a[1], a[2]), 3),
    drawLine: m4((o, a) => line(o, a[0], a[1], a[2], a[3], a[4]), 5),
    drawFastHLine: m4((o, a) => line(o, a[0], a[1], a[0] + a[2] - 1, a[1], a[3]), 4),
    drawFastVLine: m4((o, a) => line(o, a[0], a[1], a[0], a[1] + a[2] - 1, a[3]), 4),
    drawRect: m4((o, a) => {
      const [x, y, w, h, c] = a
      line(o, x, y, x + w - 1, y, c)
      line(o, x, y + h - 1, x + w - 1, y + h - 1, c)
      line(o, x, y, x, y + h - 1, c)
      line(o, x + w - 1, y, x + w - 1, y + h - 1, c)
    }, 5),
    fillRect: m4((o, a) => fillRect(o, a[0], a[1], a[2], a[3], a[4]), 5),
    fillScreen: m4((o, a) => fillRect(o, 0, 0, o.width, o.height, a[0]), 1),
    drawRoundRect: m4((o, a) => {
      const [x, y, w, h, , c] = a
      line(o, x + 2, y, x + w - 3, y, c)
      line(o, x + 2, y + h - 1, x + w - 3, y + h - 1, c)
      line(o, x, y + 2, x, y + h - 3, c)
      line(o, x + w - 1, y + 2, x + w - 1, y + h - 3, c)
    }, 6),
    fillRoundRect: m4((o, a) => fillRect(o, a[0], a[1], a[2], a[3], a[5]), 6),
    drawCircle: m4((o, a) => circle(o, a[0], a[1], a[2], a[3], false), 4),
    fillCircle: m4((o, a) => circle(o, a[0], a[1], a[2], a[3], true), 4),
    drawTriangle: m4((o, a) => triangle(o, a.slice(0, 6), a[6], false), 7),
    fillTriangle: m4((o, a) => triangle(o, a.slice(0, 6), a[6], true), 7),
    drawBitmap: {
      ret: VOID,
      min: 6,
      max: 7,
      call: (_m, self, a) => {
        const o = self as OledObj
        const [x, y] = [Number(a[0]), Number(a[1])]
        const bmp = (a[2] instanceof Ptr ? (a[2].a as number[]) : (a[2] as number[])) ?? []
        const w = Number(a[3])
        const h = Number(a[4])
        const c = Number(a[5])
        const bg = a.length > 6 ? Number(a[6]) : null
        const bw = Math.ceil(w / 8)
        for (let j = 0; j < h; j++)
          for (let i = 0; i < w; i++) {
            const byte = Number(bmp[j * bw + (i >> 3)] ?? 0) & 255
            if (byte & (0x80 >> (i & 7))) px(o, x + i, y + j, c)
            else if (bg !== null) px(o, x + i, y + j, bg)
          }
      },
    },
    setTextSize: m4((o, a) => void (o.size = Math.max(1, Math.round(a[0]))), 1, 2),
    setTextColor: m4((o, a) => {
      o.color = a[0]
      o.bg = a.length > 1 ? a[1] : null
    }, 1, 2),
    setCursor: m4((o, a) => {
      o.cx = a[0]
      o.cy = a[1]
    }, 2),
    setTextWrap: m4((o, a) => void (o.wrap = !!a[0]), 1),
    setRotation: m4(() => undefined, 1),
    cp437: m4(() => undefined, 0, 1),
    setFont: { ret: VOID, max: 1, call: (m) => m.warn('setFont(): 시뮬레이션은 기본 글꼴로 보여 줍니다') },
    invertDisplay: m4((o, a) => void (o.dev.inverted = !!a[0]), 1),
    dim: m4(() => undefined, 1),
    ssd1306_command: m4(() => undefined, 1),
    startscrollright: m4(() => undefined, 2),
    startscrollleft: m4(() => undefined, 2),
    stopscroll: m4(() => undefined, 0),
    width: { ret: I16, max: 0, call: (_m, self) => (self as OledObj).width },
    height: { ret: I16, max: 0, call: (_m, self) => (self as OledObj).height },
    getCursorX: { ret: I16, max: 0, call: (_m, self) => (self as OledObj).cx },
    getCursorY: { ret: I16, max: 0, call: (_m, self) => (self as OledObj).cy },
    getTextBounds: {
      ret: VOID,
      min: 7,
      max: 7,
      call: (_m, self, a) => {
        const o = self as OledObj
        const s = cstrText(a[0])
        const lines = s.split('\n')
        const w = Math.max(...lines.map((l) => l.length)) * 6 * o.size
        ;(a[3] as Ptr).set(Number(a[1]))
        ;(a[4] as Ptr).set(Number(a[2]))
        ;(a[5] as Ptr).set(w)
        ;(a[6] as Ptr).set(lines.length * 8 * o.size)
      },
    },
    ...printMethods((self, m, bytes) => text(m, self as OledObj, bytes)),
  }
  r.classes.set('Adafruit_SSD1306', {
    name: 'Adafruit_SSD1306',
    header: 'Adafruit_SSD1306.h',
    ctorMax: 4,
    construct: (_m, a) => {
      const width = a.length >= 2 ? Number(a[0]) : 128
      const height = a.length >= 2 ? Number(a[1]) : 64
      const dev: OledDevice = { width, height, pixels: new Uint8Array(width * height), texts: [], inverted: false, on: false, frame: 0 }
      const o: OledObj = { dev, attached: false, width, height, buf: new Uint8Array(width * height), texts: [], cx: 0, cy: 0, size: 1, color: 1, bg: null, wrap: true, begun: false }
      return o
    },
    methods,
  })
  for (const [k, v] of [['SSD1306_SWITCHCAPVCC', 2], ['SSD1306_EXTERNALVCC', 1], ['SSD1306_WHITE', 1], ['SSD1306_BLACK', 0], ['SSD1306_INVERSE', 2], ['WHITE', 1], ['BLACK', 0], ['INVERSE', 2]] as [string, number][]) num(r, k, v)
}

// ------------------------------------------------------------ Adafruit NeoPixel

interface StripObj {
  n: number
  pin: string | null
  type: number
  colors: number[]
  brightness: number
  begun: boolean
}

export function hsvToRgb(hue: number, sat: number, val: number): number {
  // Adafruit_NeoPixel::ColorHSV
  hue = ((hue % 65536) + 65536) % 65536
  hue = Math.trunc((hue * 1530 + 32768) / 65536)
  let r: number
  let g: number
  let b: number
  if (hue < 510) {
    b = 0
    if (hue < 255) {
      r = 255
      g = hue
    } else {
      r = 510 - hue
      g = 255
    }
  } else if (hue < 1020) {
    r = 0
    if (hue < 765) {
      g = 255
      b = hue - 510
    } else {
      g = 1020 - hue
      b = 255
    }
  } else if (hue < 1530) {
    g = 0
    if (hue < 1275) {
      r = hue - 1020
      b = 255
    } else {
      r = 255
      b = 1530 - hue
    }
  } else {
    r = 255
    g = 0
    b = 0
  }
  const v1 = 1 + val
  const s1 = 1 + sat
  const s2 = 255 - sat
  const f = (c: number) => ((((c * s1) >> 8) + s2) * v1) >> 8
  return (f(r) << 16) | (f(g) << 8) | f(b)
}

const GAMMA = (x: number) => Math.round(255 * Math.pow(x / 255, 2.6))

const neopixelLib: Lib = (r) => {
  const color = (a: unknown[]) => (a.length >= 4 ? ((Number(a[3]) & 255) << 24) >>> 0 : 0) + ((Number(a[0]) & 255) << 16) + ((Number(a[1]) & 255) << 8) + (Number(a[2]) & 255)
  const colorFn = { ret: U32, min: 3, max: 4, call: (_m: Machine, a: unknown[]) => color(a) }
  const hsvFn = { ret: U32, min: 1, max: 3, call: (_m: Machine, a: unknown[]) => hsvToRgb(Number(a[0]), a.length > 1 ? Number(a[1]) : 255, a.length > 2 ? Number(a[2]) : 255) }
  const gamma32 = (c: number) => (GAMMA((c >> 16) & 255) << 16) | (GAMMA((c >> 8) & 255) << 8) | GAMMA(c & 255)
  r.functions.set('Adafruit_NeoPixel::Color', colorFn)
  r.functions.set('Adafruit_NeoPixel::ColorHSV', hsvFn)
  r.functions.set('Adafruit_NeoPixel::gamma32', { ret: U32, min: 1, max: 1, call: (_m, a) => gamma32(Number(a[0])) })
  const setPixel = (o: StripObj, i: number, c: number) => {
    if (i >= 0 && i < o.n) o.colors[i] = c >>> 0
  }
  const methods: Record<string, MethodDef> = {
    begin: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as StripObj
        o.begun = true
        if (o.pin) m.host.pinMode(o.pin, 'OUTPUT', m.us)
      },
    },
    show: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as StripObj
        if (!o.begun) m.warn('strip.begin() 을 먼저 불러야 합니다')
        m.us += 30 * o.n
        if (!o.pin) return
        // 색 순서: 테이프(WS2812B)는 GRB 로 받는다. NEO_RGB 처럼 다른 순서로 보내면 색이 바뀌어 보인다
        const rOff = (o.type >> 4) & 3
        const gOff = (o.type >> 2) & 3
        const bOff = o.type & 3
        const k = o.brightness === 0 ? 1 : o.brightness / 256
        const out = o.colors.map((c) => {
          const bytes = [0, 0, 0]
          bytes[rOff] = Math.trunc(((c >> 16) & 255) * k)
          bytes[gOff] = Math.trunc(((c >> 8) & 255) * k)
          bytes[bOff] = Math.trunc((c & 255) * k)
          return (bytes[1] << 16) | (bytes[0] << 8) | bytes[2]
        })
        m.host.pixels(o.pin)?.show(out, m.us)
      },
    },
    setPixelColor: {
      ret: VOID,
      min: 2,
      max: 5,
      call: (_m, self, a) => {
        const o = self as StripObj
        setPixel(o, Number(a[0]), a.length >= 4 ? color(a.slice(1)) : Number(a[1]))
      },
    },
    getPixelColor: { ret: U32, min: 1, max: 1, call: (_m, self, a) => (self as StripObj).colors[Number(a[0])] ?? 0 },
    fill: {
      ret: VOID,
      max: 3,
      call: (_m, self, a) => {
        const o = self as StripObj
        const c = a.length ? Number(a[0]) : 0
        const first = a.length > 1 ? Number(a[1]) : 0
        const count = a.length > 2 && Number(a[2]) > 0 ? Number(a[2]) : o.n - first
        for (let i = first; i < first + count; i++) setPixel(o, i, c)
      },
    },
    clear: { ret: VOID, max: 0, call: (_m, self) => void (self as StripObj).colors.fill(0) },
    setBrightness: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as StripObj).brightness = (Number(a[0]) + 1) & 255) },
    getBrightness: { ret: U8, max: 0, call: (_m, self) => ((self as StripObj).brightness - 1) & 255 },
    numPixels: { ret: U16, max: 0, call: (_m, self) => (self as StripObj).n },
    canShow: { ret: BOOL, max: 0, call: () => 1 },
    setPin: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (m, self, a) => void ((self as StripObj).pin = m.host.pinId(Number(a[0]))),
    },
    updateLength: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (_m, self, a) => {
        const o = self as StripObj
        o.n = Number(a[0])
        o.colors = Array(o.n).fill(0)
      },
    },
    updateType: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as StripObj).type = Number(a[0])) },
    Color: { ret: U32, min: 3, max: 4, call: (_m, _self, a) => color(a) },
    ColorHSV: { ret: U32, min: 1, max: 3, call: (m, _self, a) => hsvFn.call(m, a) },
    gamma32: { ret: U32, min: 1, max: 1, call: (_m, _self, a) => gamma32(Number(a[0])) },
    gamma8: { ret: U8, min: 1, max: 1, call: (_m, _self, a) => GAMMA(Number(a[0]) & 255) },
    sine8: { ret: U8, min: 1, max: 1, call: (_m, _self, a) => Math.round(127.5 + 127.5 * Math.sin(((Number(a[0]) & 255) / 256) * 2 * Math.PI - Math.PI / 2 + Math.PI / 2)) & 255 },
    rainbow: {
      ret: VOID,
      max: 5,
      call: (_m, self, a) => {
        const o = self as StripObj
        const first = a.length > 0 ? Number(a[0]) : 0
        const reps = a.length > 1 ? Number(a[1]) : 1
        const sat = a.length > 2 ? Number(a[2]) : 255
        const bright = a.length > 3 ? Number(a[3]) : 255
        const gammify = a.length > 4 ? truthy(a[4]) : true
        for (let i = 0; i < o.n; i++) {
          const hue = first + Math.trunc((i * reps * 65536) / o.n)
          const c = hsvToRgb(hue, sat, bright)
          setPixel(o, i, gammify ? gamma32(c) : c)
        }
      },
    },
  }
  r.classes.set('Adafruit_NeoPixel', {
    name: 'Adafruit_NeoPixel',
    header: 'Adafruit_NeoPixel.h',
    ctorMax: 3,
    construct: (m, a) => {
      const n = a.length ? Number(a[0]) : 0
      const pin = a.length > 1 ? m.host.pinId(Number(a[1])) : null
      if (a.length > 1 && !pin) m.warn(`Adafruit_NeoPixel: 보드에 ${Number(a[1])}번 핀이 없습니다`)
      const o: StripObj = { n, pin, type: a.length > 2 ? Number(a[2]) : 0x52, colors: Array(n).fill(0), brightness: 0, begun: false }
      return o
    },
    methods,
  })
  const t = U16
  for (const [k, v] of [['NEO_RGB', 0x06], ['NEO_RBG', 0x09], ['NEO_GRB', 0x52], ['NEO_GBR', 0xa1], ['NEO_BRG', 0x58], ['NEO_BGR', 0xa4], ['NEO_RGBW', 0x1b], ['NEO_GRBW', 0x5a], ['NEO_KHZ800', 0x0000], ['NEO_KHZ400', 0x0100]] as [string, number][]) num(r, k, v, t)
}

// ------------------------------------------------------------ TM1637Display

const DIGITS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71]

interface SegObj {
  clk: string | null
  dio: string | null
  segs: number[]
  brightness: number
  on: boolean
}

const tm1637Lib: Lib = (r) => {
  const flush = (m: Machine, o: SegObj) => {
    m.us += 600
    if (o.clk && o.dio) m.host.seg(o.clk, o.dio)?.show(o.segs.slice(), o.brightness, o.on)
  }
  const setSegments = (m: Machine, o: SegObj, segs: number[], length = 4, pos = 0) => {
    for (let i = 0; i < length && pos + i < 4; i++) o.segs[pos + i] = Number(segs[i] ?? 0) & 255
    flush(m, o)
  }
  const baseEx = (m: Machine, o: SegObj, base: number, num: number, dots: number, leadingZero: boolean, length: number, pos: number) => {
    let negative = false
    if (base < 0) {
      base = -base
      negative = true
    }
    num &= 0xffff
    const digits = Array(length).fill(0)
    if (num === 0 && !leadingZero) {
      digits[length - 1] = DIGITS[0]
    } else {
      for (let i = length - 1; i >= 0; i--) {
        const d = num % base
        if (d === 0 && num === 0 && !leadingZero) digits[i] = 0
        else digits[i] = DIGITS[d]
        if (d === 0 && num === 0 && negative) {
          digits[i] = 0x40
          negative = false
        }
        num = Math.trunc(num / base)
      }
    }
    if (dots) {
      let dm = dots
      for (let i = 0; i < 4; i++) {
        if (digits[i] !== undefined) digits[i] |= dm & 0x80
        dm <<= 1
      }
    }
    setSegments(m, o, digits, length, pos)
  }
  const methods: Record<string, MethodDef> = {
    setBrightness: {
      ret: VOID,
      min: 1,
      max: 2,
      call: (_m, self, a) => {
        const o = self as SegObj
        o.brightness = Number(a[0]) & 7
        o.on = a.length > 1 ? truthy(a[1]) : true
      },
    },
    setSegments: {
      ret: VOID,
      min: 1,
      max: 3,
      call: (m, self, a) => {
        const src = a[0] instanceof Ptr ? (a[0].a as number[]).slice(a[0].i as number) : (a[0] as number[])
        setSegments(m, self as SegObj, src ?? [], a.length > 1 ? Number(a[1]) : 4, a.length > 2 ? Number(a[2]) : 0)
      },
    },
    clear: { ret: VOID, max: 0, call: (m, self) => setSegments(m, self as SegObj, [0, 0, 0, 0]) },
    showNumberDec: {
      ret: VOID,
      min: 1,
      max: 4,
      call: (m, self, a) => {
        const n = Number(a[0])
        baseEx(m, self as SegObj, n < 0 ? -10 : 10, Math.abs(n), 0, a.length > 1 ? truthy(a[1]) : false, a.length > 2 ? Number(a[2]) : 4, a.length > 3 ? Number(a[3]) : 0)
      },
    },
    showNumberDecEx: {
      ret: VOID,
      min: 1,
      max: 5,
      call: (m, self, a) => {
        const n = Number(a[0])
        baseEx(m, self as SegObj, n < 0 ? -10 : 10, Math.abs(n), a.length > 1 ? Number(a[1]) : 0, a.length > 2 ? truthy(a[2]) : false, a.length > 3 ? Number(a[3]) : 4, a.length > 4 ? Number(a[4]) : 0)
      },
    },
    showNumberHexEx: {
      ret: VOID,
      min: 1,
      max: 5,
      call: (m, self, a) => baseEx(m, self as SegObj, 16, Number(a[0]), a.length > 1 ? Number(a[1]) : 0, a.length > 2 ? truthy(a[2]) : false, a.length > 3 ? Number(a[3]) : 4, a.length > 4 ? Number(a[4]) : 0),
    },
    encodeDigit: { ret: U8, min: 1, max: 1, call: (_m, _self, a) => DIGITS[Number(a[0]) & 15] },
  }
  r.classes.set('TM1637Display', {
    name: 'TM1637Display',
    header: 'TM1637Display.h',
    ctorMin: 2,
    ctorMax: 3,
    construct: (m, a) => {
      const clk = m.host.pinId(Number(a[0]))
      const dio = m.host.pinId(Number(a[1]))
      return { clk, dio, segs: [0, 0, 0, 0], brightness: 7, on: true } satisfies SegObj
    },
    methods,
  })
  for (const [k, v] of [['SEG_A', 1], ['SEG_B', 2], ['SEG_C', 4], ['SEG_D', 8], ['SEG_E', 16], ['SEG_F', 32], ['SEG_G', 64], ['SEG_DP', 128]] as [string, number][]) num(r, k, v)
}

// ------------------------------------------------------------ DHT

interface DhtObj {
  pin: string | null
  type: number
  last: number
  t: number
  h: number
  ok: boolean
  begun: boolean
}

const dhtLib: Lib = (r) => {
  const read = (m: Machine, o: DhtObj, force: boolean) => {
    if (!o.begun) m.warn('dht.begin() 을 먼저 불러야 합니다')
    const now = m.us / 1000
    if (!force && o.last >= 0 && now - o.last < 2000) return o.ok
    o.last = now
    m.us += 5000
    const dev = o.pin ? m.host.dht(o.pin) : null
    const v = dev?.read(m.us) ?? null
    if (!v) {
      o.ok = false
      return false
    }
    const kind = (dev as unknown as { kind?: number }).kind
    let t = v.temperature
    let h = v.humidity
    if (kind !== undefined && kind !== o.type && !(o.type === 21 && kind === 22) && !(o.type === 22 && kind === 21)) {
      // 종류를 잘못 고르면 데이터를 다르게 해석해 엉뚱한 값이 나온다
      m.warn(`코드는 DHT${o.type} 인데 연결된 센서는 DHT${kind} 입니다. DHT dht(핀, DHT${kind}); 로 고치세요`)
      if (o.type === 11) {
        t = Math.trunc(t * 10) >> 8
        h = Math.trunc(h * 10) >> 8
      } else {
        t = (Math.trunc(t) * 256) / 10
        h = (Math.trunc(h) * 256) / 10
      }
    }
    o.t = o.type === 11 ? Math.round(t) : Math.round(t * 10) / 10
    o.h = o.type === 11 ? Math.round(h) : Math.round(h * 10) / 10
    o.ok = true
    return true
  }
  const methods: Record<string, MethodDef> = {
    begin: { ret: VOID, max: 1, call: (_m, self) => void ((self as DhtObj).begun = true) },
    read: { ret: BOOL, max: 1, call: (m, self, a) => +read(m, self as DhtObj, truthy(a[0])) },
    readTemperature: {
      ret: F32,
      max: 2,
      call: (m, self, a) => {
        const o = self as DhtObj
        if (!read(m, o, a.length > 1 && truthy(a[1]))) return NaN
        return Math.fround(a.length && truthy(a[0]) ? o.t * 1.8 + 32 : o.t)
      },
    },
    readHumidity: {
      ret: F32,
      max: 1,
      call: (m, self, a) => {
        const o = self as DhtObj
        return read(m, o, truthy(a[0])) ? Math.fround(o.h) : NaN
      },
    },
    computeHeatIndex: {
      ret: F32,
      min: 2,
      max: 3,
      call: (_m, _self, a) => {
        const isF = a.length > 2 ? truthy(a[2]) : true
        const T = isF ? Number(a[0]) : Number(a[0]) * 1.8 + 32
        const R = Number(a[1])
        let hi = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + R * 0.094)
        if (hi > 79) {
          hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R
          if (R < 13 && T >= 80 && T <= 112) hi -= ((13 - R) * 0.25) * Math.sqrt((17 - Math.abs(T - 95)) * 0.05882)
          else if (R > 85 && T >= 80 && T <= 87) hi += ((R - 85) * 0.1) * ((87 - T) * 0.2)
        }
        return Math.fround(isF ? hi : (hi - 32) / 1.8)
      },
    },
    convertCtoF: { ret: F32, min: 1, max: 1, call: (_m, _s, a) => Math.fround(Number(a[0]) * 1.8 + 32) },
    convertFtoC: { ret: F32, min: 1, max: 1, call: (_m, _s, a) => Math.fround((Number(a[0]) - 32) / 1.8) },
  }
  r.classes.set('DHT', {
    name: 'DHT',
    header: 'DHT.h',
    ctorMin: 2,
    ctorMax: 3,
    construct: (m, a) => ({ pin: m.host.pinId(Number(a[0])), type: Number(a[1]), last: -1, t: NaN, h: NaN, ok: false, begun: false }) satisfies DhtObj,
    methods,
  })
  for (const [k, v] of [['DHT11', 11], ['DHT12', 12], ['DHT22', 22], ['DHT21', 21], ['AM2301', 21]] as [string, number][]) num(r, k, v)
}

// ------------------------------------------------------------ NewPing

const newPingLib: Lib = (r) => {
  interface PingObj {
    trig: string | null
    echo: string | null
    max: number
  }
  const ping = function* (m: Machine, o: PingObj, maxCm: number): Gen<number> {
    if (!o.trig || !o.echo) return 0
    m.host.pinMode(o.trig, 'OUTPUT', m.us)
    if (o.echo !== o.trig) m.host.pinMode(o.echo, 'INPUT', m.us)
    m.host.digitalWrite(o.trig, false, m.us)
    m.us += 4
    m.host.digitalWrite(o.trig, true, m.us)
    m.us += 10
    m.host.digitalWrite(o.trig, false, m.us)
    const timeout = Math.min(maxCm, o.max) * 57 + 57 * 4
    const { width, end } = m.host.pulseIn(o.echo, true, timeout + 500, m.us)
    yield* waitUntil(m, end)
    if (!width || width > timeout) return 0
    return width
  }
  const conv = (us: number, f: number) => Math.max(Math.trunc((us + f / 2) / f), us ? 1 : 0)
  const methods: Record<string, MethodDef> = {
    ping: { ret: U32, max: 1, gen: (m, self, a) => ping(m, self as PingObj, a.length ? Number(a[0]) : (self as PingObj).max) },
    ping_cm: {
      ret: U32,
      max: 1,
      gen: function* (m, self, a) {
        return conv(yield* ping(m, self as PingObj, a.length ? Number(a[0]) : (self as PingObj).max), 57)
      },
    },
    ping_in: {
      ret: U32,
      max: 1,
      gen: function* (m, self, a) {
        return conv(yield* ping(m, self as PingObj, a.length ? Number(a[0]) : (self as PingObj).max), 146)
      },
    },
    ping_median: {
      ret: U32,
      max: 2,
      gen: function* (m, self, a) {
        const it = a.length ? Math.max(1, Number(a[0])) : 5
        const vals: number[] = []
        for (let i = 0; i < it; i++) {
          const v = yield* ping(m, self as PingObj, a.length > 1 ? Number(a[1]) : (self as PingObj).max)
          if (v) vals.push(v)
          if (i < it - 1) yield* waitUntil(m, m.us + 29000)
        }
        vals.sort((x, y) => x - y)
        return vals.length ? vals[Math.floor(vals.length / 2)] : 0
      },
    },
    convert_cm: { ret: U32, min: 1, max: 1, call: (_m, _s, a) => conv(Number(a[0]), 57) },
  }
  r.classes.set('NewPing', {
    name: 'NewPing',
    header: 'NewPing.h',
    ctorMin: 2,
    ctorMax: 3,
    construct: (m, a) => ({ trig: m.host.pinId(Number(a[0])), echo: m.host.pinId(Number(a[1])), max: a.length > 2 ? Number(a[2]) : 500 }),
    methods,
  })
  r.functions.set('NewPing::convert_cm', { ret: U32, min: 1, max: 1, call: (_m, a) => conv(Number(a[0]), 57) })
  num(r, 'NO_ECHO', 0)
  num(r, 'US_ROUNDTRIP_CM', 57)
}

// ------------------------------------------------------------ SoftwareSerial

const softSerialLib: Lib = (r) => {
  interface SoftObj {
    port: SerialPort
    timeout: number
  }
  r.classes.set('SoftwareSerial', {
    name: 'SoftwareSerial',
    header: 'SoftwareSerial.h',
    ctorMin: 2,
    ctorMax: 3,
    construct: (m, a) => {
      const rx = m.host.pinId(Number(a[0]))
      const tx = m.host.pinId(Number(a[1]))
      return { port: m.host.softSerial(rx, tx), timeout: 1000 } satisfies SoftObj
    },
    methods: {
      begin: { ret: VOID, min: 1, max: 1, call: (m, self, a) => (self as SoftObj).port.begin(Number(a[0]), m.us) },
      end: { ret: VOID, max: 0, call: () => undefined },
      listen: { ret: BOOL, max: 0, call: () => 1 },
      isListening: { ret: BOOL, max: 0, call: () => 1 },
      overflow: { ret: BOOL, max: 0, call: () => 0 },
      ...printMethods((self, m, bytes) => (self as SoftObj).port.write(bytes, m.us)),
      ...streamMethods(
        (self) => (self as SoftObj).port,
        (self) => (self as SoftObj).timeout,
        (self, ms) => ((self as SoftObj).timeout = ms),
      ),
    },
  })
}

// ------------------------------------------------------------ MFRC522

const UID = struct('MFRC522::Uid', [
  ['size', U8],
  ['uidByte', arr(U8, 10)],
  ['sak', U8],
])
const MIFARE_KEY = struct('MFRC522::MIFARE_Key', [['keyByte', arr(U8, 6)]])

const rfidLib: Lib = (r, board) => {
  interface RfidObj {
    ss: string | null
    uid: { size: number; uidByte: number[]; sak: number }
    pending: number[] | null
    memory: Map<string, number[]>
    begun: boolean
  }
  const serialOut = (m: Machine, text: string) => m.host.serial('Serial')?.write(utf8(text), m.us)
  const STATUS: Record<string, number> = { STATUS_OK: 0, STATUS_ERROR: 1, STATUS_COLLISION: 2, STATUS_TIMEOUT: 3, STATUS_NO_ROOM: 4, STATUS_INTERNAL_ERROR: 5, STATUS_INVALID: 6, STATUS_CRC_WRONG: 7, STATUS_MIFARE_NACK: 0xff }
  const statusName = (c: number) => (c === 0 ? 'Success.' : c === 3 ? 'Timeout in communication.' : 'Error in communication.')
  const int = intOf
  const methods: Record<string, MethodDef> = {
    PCD_Init: {
      ret: VOID,
      max: 2,
      call: (m, self, a) => {
        const o = self as RfidObj
        if (a.length >= 1) o.ss = m.host.pinId(Number(a[0]))
        if (!m.state.spiBegun) m.warn('mfrc522.PCD_Init() 전에 SPI.begin() 을 불러야 합니다')
        o.begun = true
        m.us += 50000
      },
    },
    PCD_DumpVersionToSerial: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const dev = (self as RfidObj).ss ? m.host.rfid((self as RfidObj).ss!) : null
        serialOut(m, dev ? 'Firmware Version: 0x92 = v2.0\r\n' : 'Firmware Version: 0x0 = (unknown)\r\nWARNING: Communication failure, is the MFRC522 properly connected?\r\n')
      },
    },
    PCD_PerformSelfTest: { ret: BOOL, max: 0, call: (m, self) => ((self as RfidObj).ss && m.host.rfid((self as RfidObj).ss!) ? 1 : 0) },
    PCD_ReadRegister: { ret: U8, min: 1, max: 1, call: (m, self) => ((self as RfidObj).ss && m.host.rfid((self as RfidObj).ss!) ? 0x92 : 0) },
    PCD_SetAntennaGain: { ret: VOID, min: 1, max: 1, call: () => undefined },
    PCD_AntennaOn: { ret: VOID, max: 0, call: () => undefined },
    PCD_AntennaOff: { ret: VOID, max: 0, call: () => undefined },
    PICC_IsNewCardPresent: {
      ret: BOOL,
      max: 0,
      call: (m, self) => {
        const o = self as RfidObj
        if (!o.begun) return 0
        m.us += 2000
        const dev = o.ss ? m.host.rfid(o.ss) : null
        const uid = dev?.newCard(m.us) ?? null
        if (uid) o.pending = uid
        return uid ? 1 : 0
      },
    },
    PICC_ReadCardSerial: {
      ret: BOOL,
      max: 0,
      call: (m, self) => {
        const o = self as RfidObj
        if (!o.pending) return 0
        o.uid.size = o.pending.length
        o.uid.uidByte = [...o.pending, ...Array(10 - o.pending.length).fill(0)]
        o.uid.sak = 0x08
        m.us += 3000
        return 1
      },
    },
    PICC_HaltA: {
      ret: U8,
      max: 0,
      call: (m, self) => {
        const o = self as RfidObj
        o.pending = null
        if (o.ss) m.host.rfid(o.ss)?.halt()
        return 0
      },
    },
    PCD_StopCrypto1: { ret: VOID, max: 0, call: () => undefined },
    PICC_GetType: { ret: U8, min: 1, max: 1, call: (_m, _s, a) => (Number(a[0]) === 0x08 ? 7 : 0) },
    PICC_GetTypeName: { ret: CSTR, min: 1, max: 1, call: (_m, _s, a) => (Number(a[0]) === 7 ? 'MIFARE 1KB' : 'Unknown type') },
    GetStatusCodeName: { ret: CSTR, min: 1, max: 1, call: (_m, _s, a) => statusName(Number(a[0])) },
    PICC_DumpToSerial: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (m, self) => {
        const o = self as RfidObj
        serialOut(m, `Card UID: ${o.uid.uidByte.slice(0, o.uid.size).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}\r\nCard SAK: 08\r\nPICC type: MIFARE 1KB\r\n`)
      },
    },
    PCD_Authenticate: { ret: U8, min: 4, max: 4, call: (_m, self) => ((self as RfidObj).pending || (self as RfidObj).uid.size ? 0 : 3) },
    MIFARE_Read: {
      ret: U8,
      min: 3,
      max: 3,
      call: (_m, self, a) => {
        const o = self as RfidObj
        const key = `${o.uid.uidByte.slice(0, o.uid.size).join(':')}#${Number(a[0])}`
        const data = o.memory.get(key) ?? Array(16).fill(0)
        const buf = a[1] instanceof Ptr ? (a[1].a as number[]) : (a[1] as number[])
        const size = a[2] as Ptr
        if (!Array.isArray(buf) || buf.length < 18) return 4
        for (let i = 0; i < 16; i++) buf[i] = data[i]
        buf[16] = 0
        buf[17] = 0
        size?.set?.(18)
        return 0
      },
    },
    MIFARE_Write: {
      ret: U8,
      min: 3,
      max: 3,
      call: (_m, self, a) => {
        const o = self as RfidObj
        const key = `${o.uid.uidByte.slice(0, o.uid.size).join(':')}#${Number(a[0])}`
        const buf = a[1] instanceof Ptr ? (a[1].a as number[]) : (a[1] as number[])
        if (!Array.isArray(buf) || Number(a[2]) < 16) return 6
        o.memory.set(key, buf.slice(0, 16).map((b) => Number(b) & 255))
        return 0
      },
    },
  }
  const statics: Record<string, { t: CType; v: unknown }> = {}
  for (const [k, v] of Object.entries(STATUS)) statics[k] = { t: U8, v }
  for (const [k, v] of [['PICC_TYPE_UNKNOWN', 0], ['PICC_TYPE_MIFARE_MINI', 6], ['PICC_TYPE_MIFARE_1K', 7], ['PICC_TYPE_MIFARE_4K', 8], ['PICC_TYPE_MIFARE_UL', 9], ['PICC_CMD_MF_AUTH_KEY_A', 0x60], ['PICC_CMD_MF_AUTH_KEY_B', 0x61], ['VersionReg', 0x37 << 1], ['RxGain_max', 0x07 << 4]] as [string, number][])
    statics[k] = { t: U8, v }
  r.classes.set('MFRC522', {
    name: 'MFRC522',
    header: 'MFRC522.h',
    ctorMax: 2,
    construct: (m, a) => {
      const ss = a.length >= 1 ? m.host.pinId(Number(a[0])) : m.host.pinId(board.kind === 'mega' ? 53 : board.kind === 'esp32' ? 5 : 10)
      return { ss, uid: { size: 0, uidByte: Array(10).fill(0), sak: 0 }, pending: null, memory: new Map(), begun: false }
    },
    methods,
    fields: { uid: UID },
    statics,
    types: { Uid: UID, MIFARE_Key: MIFARE_KEY, PICC_Type: U8, StatusCode: U8, PICC_Command: U8, PCD_Register: U8 },
  })
  void int
}

// ------------------------------------------------------------ EEPROM

const eepromLib: Lib = (r, board) => {
  interface Eeprom {
    data: number[]
    values: Map<number, unknown>
  }
  const size = board.kind === 'mega' ? 4096 : board.kind === 'esp32' ? 4096 : 1024
  const check = (o: Eeprom, addr: number) => {
    if (addr < 0 || addr >= o.data.length) throw new RuntimeErr(`EEPROM 주소 ${addr} 이(가) 범위(0–${o.data.length - 1})를 벗어났습니다`)
  }
  const bytesOf = (v: unknown, t: CType): number[] => {
    if (t.k === 'int') {
      const n = t.bits / 8
      const out: number[] = []
      let x = BigInt.asUintN(t.bits, BigInt(Math.trunc(Number(v))))
      for (let i = 0; i < n; i++) {
        out.push(Number(x & 255n))
        x >>= 8n
      }
      return out
    }
    if (t.k === 'float') {
      const buf = new DataView(new ArrayBuffer(t.bits / 8))
      if (t.bits === 32) buf.setFloat32(0, Number(v), true)
      else buf.setFloat64(0, Number(v), true)
      return Array.from(new Uint8Array(buf.buffer))
    }
    return []
  }
  const methods: Record<string, MethodDef> = {
    read: {
      ret: U8,
      min: 1,
      max: 1,
      call: (_m, self, a) => {
        const o = self as Eeprom
        check(o, Number(a[0]))
        return o.data[Number(a[0])]
      },
    },
    write: {
      ret: VOID,
      min: 2,
      max: 2,
      call: (m, self, a) => {
        const o = self as Eeprom
        check(o, Number(a[0]))
        o.data[Number(a[0])] = Number(a[1]) & 255
        o.values.delete(Number(a[0]))
        m.us += 3300
      },
    },
    get: {
      ret: VOID,
      min: 2,
      max: 2,
      refArgs: [1],
      call: (_m, self, a) => {
        const o = self as Eeprom
        const addr = Number(a[0])
        const target = a[1] as Ptr
        check(o, addr)
        const t = target.t
        if (o.values.has(addr)) {
          target.a[target.i as never] = JSON.parse(JSON.stringify(o.values.get(addr))) as never
          return
        }
        if (t.k === 'int' || t.k === 'float') {
          const n = t.bits / 8
          const bytes = o.data.slice(addr, addr + n)
          if (t.k === 'float') {
            const dv = new DataView(new Uint8Array(bytes).buffer)
            target.set(t.bits === 32 ? dv.getFloat32(0, true) : dv.getFloat64(0, true))
          } else {
            let x = 0n
            for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i] ?? 0)
            target.set(Number(t.signed ? BigInt.asIntN(t.bits, x) : x))
          }
        }
      },
    },
    put: {
      ret: VOID,
      min: 2,
      max: 2,
      call: (m, self, a, t) => {
        const o = self as Eeprom
        const addr = Number(a[0])
        check(o, addr)
        const bytes = bytesOf(a[1], t[1])
        bytes.forEach((b, i) => {
          if (addr + i < o.data.length) o.data[addr + i] = b
        })
        if (!bytes.length) o.values.set(addr, JSON.parse(JSON.stringify(a[1])))
        else o.values.delete(addr)
        m.us += 3300 * Math.max(1, bytes.length)
      },
    },
    length: { ret: U16, max: 0, call: (_m, self) => (self as Eeprom).data.length },
    begin: { ret: BOOL, min: 1, max: 1, core: 'esp32', call: () => 1 },
    commit: { ret: BOOL, max: 0, core: 'esp32', call: () => 1 },
    end: { ret: VOID, max: 0, call: () => undefined },
  }
  methods.update = methods.write
  r.classes.set('EEPROMClass', { name: 'EEPROMClass', header: 'EEPROM.h', construct: () => ({}), methods, index: { t: U8, container: (self) => (self as Eeprom).data } })
  r.objects.set('EEPROM', {
    cls: 'EEPROMClass',
    make: (m) => {
      const data = m.host.storage('eeprom', size)
      return { data, values: new Map() } satisfies Eeprom
    },
  })
}

// ------------------------------------------------------------ AVR 헤더 (watchdog, sleep)

const wdtLib: Lib = (r) => {
  r.functions.set('wdt_enable', { ret: VOID, min: 1, max: 1, call: () => undefined })
  r.functions.set('wdt_reset', { ret: VOID, max: 0, call: () => undefined })
  r.functions.set('wdt_disable', { ret: VOID, max: 0, call: () => undefined })
  for (const [k, v] of [['WDTO_15MS', 0], ['WDTO_30MS', 1], ['WDTO_60MS', 2], ['WDTO_120MS', 3], ['WDTO_250MS', 4], ['WDTO_500MS', 5], ['WDTO_1S', 6], ['WDTO_2S', 7], ['WDTO_4S', 8], ['WDTO_8S', 9]] as [string, number][]) num(r, k, v)
}

const sleepLib: Lib = (r) => {
  for (const n of ['set_sleep_mode', 'sleep_enable', 'sleep_disable', 'sleep_cpu', 'sleep_mode']) r.functions.set(n, { ret: VOID, max: 1, call: () => undefined })
  for (const [k, v] of [['SLEEP_MODE_IDLE', 0], ['SLEEP_MODE_PWR_DOWN', 2], ['SLEEP_MODE_PWR_SAVE', 3], ['SLEEP_MODE_STANDBY', 6]] as [string, number][]) num(r, k, v)
}

const LIBS: Record<string, Lib> = {
  'Servo.h': servoLib,
  'ESP32Servo.h': servoLib,
  'Wire.h': wireLib,
  'SPI.h': spiLib,
  'LiquidCrystal_I2C.h': lcdLib,
  'Adafruit_SSD1306.h': oledLib,
  'Adafruit_NeoPixel.h': neopixelLib,
  'TM1637Display.h': tm1637Lib,
  'DHT.h': dhtLib,
  'DHT_U.h': dhtLib,
  'NewPing.h': newPingLib,
  'SoftwareSerial.h': softSerialLib,
  'MFRC522.h': rfidLib,
  'EEPROM.h': eepromLib,
  'avr/wdt.h': wdtLib,
  'avr/sleep.h': sleepLib,
}

export const SUPPORTED_LIBRARIES = (): string[] => [...Object.keys(LIBS), ...Object.keys(motorLibraries)]

export { BOOL, CSTR, F32, STRING, U16, U32, U8, VOID, convert, longOf, waitFor, waitUntil }
export type { ClassDef }
