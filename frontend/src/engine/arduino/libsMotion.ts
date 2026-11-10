import { BOOL, F32, I16, I32, U16, U32, U8, VOID, intOf, longOf, truthy, type CType, type Platform } from './ctypes'
import { waitUntil, type BoardInfo } from './core'
import type { Gen, Machine, MethodDef, Registry } from './machine'
import { Ptr, RuntimeErr } from './values'

// 모터·센서 라이브러리: Stepper, AccelStepper, Adafruit PWM Servo Driver, MPU-6050, FastLED

type Reg = Partial<Registry> & Pick<Registry, 'functions' | 'constants' | 'classes' | 'objects' | 'types'>
type Lib = (r: Reg, board: BoardInfo, p: Platform) => void

const struct = (name: string, fields: [string, CType][]): CType & { k: 'struct' } => ({ k: 'struct', name, fields: fields.map(([n, type]) => ({ name: n, type })) })
const num = (r: Reg, name: string, v: number, t: CType = U8) => r.constants.set(name, { t, v })

// ------------------------------------------------------------ Stepper

interface StepperObj {
  pins: (string | null)[]
  steps: number
  delayUs: number
  number: number
  last: number
}

const STEPPER_4 = [0b1010, 0b0110, 0b0101, 0b1001]
const STEPPER_2 = [0b01, 0b11, 0b10, 0b00]

const stepperLib: Lib = (r) => {
  const out = (m: Machine, o: StepperObj, phase: number) => {
    const seq = o.pins.length === 4 ? STEPPER_4 : STEPPER_2
    const mask = seq[phase & 3]
    const n = o.pins.length
    // 시퀀스의 왼쪽 비트가 첫 번째 핀
    o.pins.forEach((pin, i) => {
      if (pin) m.host.digitalWrite(pin, !!((mask >> (n - 1 - i)) & 1), m.us)
    })
  }
  r.classes.set('Stepper', {
    name: 'Stepper',
    header: 'Stepper.h',
    ctorMin: 3,
    ctorMax: 5,
    construct: (m, a) => {
      const pins = a.slice(1).map((n) => m.host.pinId(Number(n)))
      if (pins.length === 3) throw new RuntimeErr('Stepper 는 핀 2개 또는 4개로 만듭니다')
      for (const p of pins) if (p) m.host.pinMode(p, 'OUTPUT', m.us)
      return { pins, steps: Number(a[0]), delayUs: 0, number: 0, last: 0 } satisfies StepperObj
    },
    methods: {
      setSpeed: {
        ret: VOID,
        min: 1,
        max: 1,
        call: (_m, self, a) => {
          const o = self as StepperObj
          const rpm = Number(a[0])
          o.delayUs = rpm > 0 ? (60 * 1000 * 1000) / o.steps / rpm : 0
        },
      },
      step: {
        ret: VOID,
        min: 1,
        max: 1,
        gen: function* (m, self, a): Gen {
          const o = self as StepperObj
          let left = Math.abs(Number(a[0]))
          const dir = Number(a[0]) > 0 ? 1 : -1
          while (left > 0) {
            if (m.us - o.last < o.delayUs) yield* waitUntil(m, o.last + o.delayUs)
            o.last = m.us
            o.number = (o.number + dir + o.steps) % o.steps
            left--
            out(m, o, o.number % 4)
            m.us += 20
            if (o.delayUs === 0 && m.shouldYield()) yield 0
          }
          return undefined
        },
      },
      version: { ret: (_t, p) => intOf(p), max: 0, call: () => 5 },
    },
  })
}

// ------------------------------------------------------------ AccelStepper

interface Accel {
  iface: number
  pins: (string | null)[]
  enable: string | null
  pos: number
  target: number
  speed: number
  maxSpeed: number
  accel: number
  interval: number
  last: number
  n: number
  c0: number
  cn: number
  cmin: number
  dir: number
  minPulse: number
  inverted: boolean[]
}

const accelStepperLib: Lib = (r) => {
  const CW = 1
  const CCW = 0
  const setOutputs = (m: Machine, o: Accel, mask: number) => {
    const count = o.iface === 1 || o.iface === 2 ? 2 : o.iface === 3 || o.iface === 6 ? 3 : 4
    for (let i = 0; i < count; i++) {
      const pin = o.pins[i]
      if (pin) m.host.digitalWrite(pin, !!((mask >> i) & 1) !== !!o.inverted[i], m.us)
    }
  }
  const stepOut = (m: Machine, o: Accel, step: number) => {
    switch (o.iface) {
      case 1: // DRIVER: 0 = STEP, 1 = DIR
        setOutputs(m, o, o.dir ? 0b10 : 0b00)
        setOutputs(m, o, o.dir ? 0b11 : 0b01)
        m.us += o.minPulse
        setOutputs(m, o, o.dir ? 0b10 : 0b00)
        break
      case 2:
        setOutputs(m, o, [0b10, 0b11, 0b01, 0b00][step & 3])
        break
      case 3:
        setOutputs(m, o, [0b100, 0b001, 0b010][((step % 3) + 3) % 3])
        break
      case 4:
        setOutputs(m, o, [0b0101, 0b0110, 0b1010, 0b1001][step & 3])
        break
      case 6:
        setOutputs(m, o, [0b100, 0b101, 0b001, 0b011, 0b010, 0b110][((step % 6) + 6) % 6])
        break
      case 8:
        setOutputs(m, o, [0b0001, 0b0101, 0b0100, 0b0110, 0b0010, 0b1010, 0b1000, 0b1001][step & 7])
        break
    }
  }
  const runSpeed = (m: Machine, o: Accel): boolean => {
    if (!o.interval) return false
    const time = m.us
    if (time - o.last >= o.interval) {
      o.pos += o.dir === CW ? 1 : -1
      stepOut(m, o, o.pos)
      o.last = time
      return true
    }
    return false
  }
  const computeNewSpeed = (o: Accel) => {
    const distanceTo = o.target - o.pos
    const stepsToStop = Math.trunc((o.speed * o.speed) / (2.0 * o.accel))
    if (distanceTo === 0 && stepsToStop <= 1) {
      o.interval = 0
      o.speed = 0
      o.n = 0
      return
    }
    if (distanceTo > 0) {
      if (o.n > 0) {
        if (stepsToStop >= distanceTo || o.dir === CCW) o.n = -stepsToStop
      } else if (o.n < 0) {
        if (stepsToStop < distanceTo && o.dir === CW) o.n = -o.n
      }
    } else if (distanceTo < 0) {
      if (o.n > 0) {
        if (stepsToStop >= -distanceTo || o.dir === CW) o.n = -stepsToStop
      } else if (o.n < 0) {
        if (stepsToStop < -distanceTo && o.dir === CCW) o.n = -o.n
      }
    }
    if (o.n === 0) {
      o.cn = o.c0
      o.dir = distanceTo > 0 ? CW : CCW
    } else {
      o.cn = o.cn - (2.0 * o.cn) / (4.0 * o.n + 1)
      o.cn = Math.max(o.cn, o.cmin)
    }
    o.n++
    o.interval = o.cn
    o.speed = 1000000.0 / o.cn
    if (o.dir === CCW) o.speed = -o.speed
  }
  const moveTo = (o: Accel, abs: number) => {
    if (o.target !== abs) {
      o.target = abs
      computeNewSpeed(o)
    }
  }
  const run = (m: Machine, o: Accel): boolean => {
    if (runSpeed(m, o)) computeNewSpeed(o)
    return o.speed !== 0 || o.target - o.pos !== 0
  }
  const setAccel = (o: Accel, a: number) => {
    if (a === 0) return
    if (a < 0) a = -a
    if (o.accel !== a) {
      o.n = o.n * (o.accel / a)
      o.c0 = 0.676 * Math.sqrt(2.0 / a) * 1000000.0
      o.accel = a
      computeNewSpeed(o)
    }
  }
  const setMax = (o: Accel, s: number) => {
    if (s < 0) s = -s
    if (o.maxSpeed !== s) {
      o.maxSpeed = s
      o.cmin = 1000000.0 / s
      if (o.n > 0) {
        o.n = Math.trunc((o.speed * o.speed) / (2.0 * o.accel))
        computeNewSpeed(o)
      }
    }
  }
  /** 다음 스텝 시각까지 기다리며 run() 을 반복 (runToPosition) */
  const runTo = function* (m: Machine, o: Accel): Gen {
    while (run(m, o)) {
      if (o.interval > 0) {
        const next = o.last + o.interval
        if (next > m.us) yield* waitUntil(m, next)
      }
      m.us += 2
      if (m.shouldYield()) yield 0
    }
    return undefined
  }
  const L = longOf()
  const methods: Record<string, MethodDef> = {
    moveTo: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => moveTo(self as Accel, Math.trunc(Number(a[0]))) },
    move: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => moveTo(self as Accel, (self as Accel).pos + Math.trunc(Number(a[0]))) },
    run: { ret: BOOL, max: 0, call: (m, self) => +run(m, self as Accel) },
    runSpeed: { ret: BOOL, max: 0, call: (m, self) => +runSpeed(m, self as Accel) },
    runSpeedToPosition: {
      ret: BOOL,
      max: 0,
      call: (m, self) => {
        const o = self as Accel
        if (o.target === o.pos) return 0
        o.dir = o.target > o.pos ? CW : CCW
        return +runSpeed(m, o)
      },
    },
    runToPosition: { ret: VOID, max: 0, gen: (m, self) => runTo(m, self as Accel) },
    runToNewPosition: {
      ret: VOID,
      min: 1,
      max: 1,
      gen: function* (m, self, a) {
        moveTo(self as Accel, Math.trunc(Number(a[0])))
        yield* runTo(m, self as Accel)
        return undefined
      },
    },
    setMaxSpeed: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => setMax(self as Accel, Number(a[0])) },
    maxSpeed: { ret: F32, max: 0, call: (_m, self) => (self as Accel).maxSpeed },
    setAcceleration: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => setAccel(self as Accel, Number(a[0])) },
    acceleration: { ret: F32, max: 0, call: (_m, self) => (self as Accel).accel },
    setSpeed: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (_m, self, a) => {
        const o = self as Accel
        let s = Number(a[0])
        if (s === o.speed) return
        s = Math.max(-o.maxSpeed, Math.min(o.maxSpeed, s))
        if (s === 0) o.interval = 0
        else {
          o.interval = Math.abs(1000000.0 / s)
          o.dir = s > 0 ? CW : CCW
        }
        o.speed = s
      },
    },
    speed: { ret: F32, max: 0, call: (_m, self) => Math.fround((self as Accel).speed) },
    distanceToGo: { ret: L, max: 0, call: (_m, self) => (self as Accel).target - (self as Accel).pos },
    targetPosition: { ret: L, max: 0, call: (_m, self) => (self as Accel).target },
    currentPosition: { ret: L, max: 0, call: (_m, self) => (self as Accel).pos },
    setCurrentPosition: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (_m, self, a) => {
        const o = self as Accel
        o.target = o.pos = Math.trunc(Number(a[0]))
        o.n = 0
        o.interval = 0
        o.speed = 0
      },
    },
    stop: {
      ret: VOID,
      max: 0,
      call: (_m, self) => {
        const o = self as Accel
        if (o.speed !== 0) {
          const stepsToStop = Math.trunc((o.speed * o.speed) / (2.0 * o.accel)) + 1
          moveTo(o, o.pos + (o.speed > 0 ? stepsToStop : -stepsToStop))
        }
      },
    },
    isRunning: { ret: BOOL, max: 0, call: (_m, self) => +!((self as Accel).speed === 0 && (self as Accel).target === (self as Accel).pos) },
    setMinPulseWidth: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as Accel).minPulse = Number(a[0])) },
    setEnablePin: {
      ret: VOID,
      max: 1,
      call: (m, self, a) => {
        const o = self as Accel
        o.enable = a.length && Number(a[0]) !== 0xff ? m.host.pinId(Number(a[0])) : null
        if (o.enable) {
          m.host.pinMode(o.enable, 'OUTPUT', m.us)
          m.host.digitalWrite(o.enable, true, m.us)
        }
      },
    },
    setPinsInverted: {
      ret: VOID,
      max: 5,
      call: (_m, self, a) => {
        const o = self as Accel
        a.forEach((v, i) => (o.inverted[i] = truthy(v)))
      },
    },
    enableOutputs: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as Accel
        for (const p of o.pins) if (p) m.host.pinMode(p, 'OUTPUT', m.us)
        if (o.enable) m.host.digitalWrite(o.enable, true, m.us)
      },
    },
    disableOutputs: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as Accel
        setOutputs(m, o, 0)
        if (o.enable) m.host.digitalWrite(o.enable, false, m.us)
      },
    },
  }
  r.classes.set('AccelStepper', {
    name: 'AccelStepper',
    header: 'AccelStepper.h',
    ctorMax: 6,
    construct: (m, a) => {
      const iface = a.length ? Number(a[0]) : 4
      if (iface === 0) throw new RuntimeErr('AccelStepper::FUNCTION (함수 지정) 방식은 지원하지 않습니다')
      const nums = [2, 3, 4, 5].map((d, i) => (a.length > i + 1 ? Number(a[i + 1]) : d))
      const pins = nums.map((n) => m.host.pinId(n))
      const o: Accel = { iface, pins, enable: null, pos: 0, target: 0, speed: 0, maxSpeed: 1, accel: 0, interval: 0, last: 0, n: 0, c0: 0, cn: 0, cmin: 1000000, dir: CCW, minPulse: 1, inverted: [false, false, false, false, false] }
      const count = iface === 1 || iface === 2 ? 2 : iface === 3 || iface === 6 ? 3 : 4
      if (a.length <= 5 || truthy(a[5])) for (const p of pins.slice(0, count)) if (p) m.host.pinMode(p, 'OUTPUT', m.us)
      setAccel(o, 1)
      return o
    },
    methods,
    statics: Object.fromEntries(
      [
        ['FUNCTION', 0],
        ['DRIVER', 1],
        ['FULL2WIRE', 2],
        ['FULL3WIRE', 3],
        ['FULL4WIRE', 4],
        ['HALF3WIRE', 6],
        ['HALF4WIRE', 8],
      ].map(([k, v]) => [k, { t: U8, v }]),
    ),
  })
}

// ------------------------------------------------------------ Adafruit PWM Servo Driver (PCA9685)

interface PcaObj {
  addr: number
  osc: number
  begun: boolean
}

const pcaLib: Lib = (r) => {
  const write = (m: Machine, o: PcaObj, bytes: number[]) => m.host.i2cWrite(o.addr, bytes, m.us)
  const read8 = (m: Machine, o: PcaObj, reg: number) => {
    m.host.i2cWrite(o.addr, [reg], m.us)
    return m.host.i2cRead(o.addr, 1, m.us)[0] ?? 0
  }
  const setPWM = (m: Machine, o: PcaObj, ch: number, on: number, off: number) => {
    m.us += 500
    write(m, o, [0x06 + 4 * ch, on & 0xff, (on >> 8) & 0x1f, off & 0xff, (off >> 8) & 0x1f])
  }
  const setFreq = (m: Machine, o: PcaObj, freq: number) => {
    freq = Math.max(1, Math.min(3500, freq))
    let prescale = Math.round(o.osc / (freq * 4096.0)) - 1
    prescale = Math.max(3, Math.min(255, prescale))
    const old = read8(m, o, 0x00)
    write(m, o, [0x00, (old & ~0x80) | 0x10])
    write(m, o, [0xfe, prescale])
    write(m, o, [0x00, old & ~0x10])
    write(m, o, [0x00, (old & ~0x10) | 0xa0])
  }
  const methods: Record<string, MethodDef> = {
    begin: {
      ret: BOOL,
      max: 1,
      call: (m, self, a) => {
        const o = self as PcaObj
        o.begun = true
        const ok = write(m, o, [0x00, 0x80]) === 0
        if (!ok) m.warn(`I²C 주소 0x${o.addr.toString(16).toUpperCase()} 에 PCA9685 가 없습니다 (배선·주소를 확인하세요)`)
        if (a.length) write(m, o, [0xfe, Number(a[0])])
        else setFreq(m, o, 1000)
        return ok ? 1 : 0
      },
    },
    reset: { ret: VOID, max: 0, call: (m, self) => void write(m, self as PcaObj, [0x00, 0x80]) },
    sleep: { ret: VOID, max: 0, call: (m, self) => void write(m, self as PcaObj, [0x00, read8(m, self as PcaObj, 0) | 0x10]) },
    wakeup: { ret: VOID, max: 0, call: (m, self) => void write(m, self as PcaObj, [0x00, read8(m, self as PcaObj, 0) & ~0x10]) },
    setOscillatorFrequency: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as PcaObj).osc = Number(a[0])) },
    getOscillatorFrequency: { ret: U32, max: 0, call: (_m, self) => (self as PcaObj).osc },
    setPWMFreq: { ret: VOID, min: 1, max: 1, call: (m, self, a) => setFreq(m, self as PcaObj, Number(a[0])) },
    setPWM: { ret: U8, min: 3, max: 3, call: (m, self, a) => (setPWM(m, self as PcaObj, Number(a[0]) & 15, Number(a[1]), Number(a[2])), 0) },
    setPin: {
      ret: VOID,
      min: 2,
      max: 3,
      call: (m, self, a) => {
        const ch = Number(a[0]) & 15
        let val = Math.min(Number(a[1]), 4095)
        if (a.length > 2 && truthy(a[2])) val = 4095 - val
        if (val === 4095) setPWM(m, self as PcaObj, ch, 4096, 0)
        else if (val === 0) setPWM(m, self as PcaObj, ch, 0, 4096)
        else setPWM(m, self as PcaObj, ch, 0, val)
      },
    },
    readPrescale: { ret: U8, max: 0, call: (m, self) => read8(m, self as PcaObj, 0xfe) },
    getPWM: {
      ret: U16,
      min: 1,
      max: 2,
      call: (m, self, a) => {
        const o = self as PcaObj
        m.host.i2cWrite(o.addr, [0x06 + 4 * (Number(a[0]) & 15) + (a.length > 1 && truthy(a[1]) ? 0 : 2)], m.us)
        const b = m.host.i2cRead(o.addr, 2, m.us)
        return (b[0] ?? 0) | ((b[1] ?? 0) << 8)
      },
    },
    writeMicroseconds: {
      ret: VOID,
      min: 2,
      max: 2,
      call: (m, self, a) => {
        const o = self as PcaObj
        const prescale = read8(m, o, 0xfe) + 1
        const pulselength = (1000000 * prescale) / o.osc
        setPWM(m, o, Number(a[0]) & 15, 0, Math.trunc(Number(a[1]) / pulselength))
      },
    },
  }
  r.classes.set('Adafruit_PWMServoDriver', {
    name: 'Adafruit_PWMServoDriver',
    header: 'Adafruit_PWMServoDriver.h',
    ctorMax: 2,
    construct: (_m, a) => ({ addr: a.length ? Number(a[0]) & 0x7f : 0x40, osc: 27000000, begun: false }) satisfies PcaObj,
    methods,
  })
}

// ------------------------------------------------------------ MPU-6050

const VEC = struct('sensors_vec_t', [
  ['x', F32],
  ['y', F32],
  ['z', F32],
  ['roll', F32],
  ['pitch', F32],
  ['heading', F32],
])
const EVENT = struct('sensors_event_t', [
  ['version', I32],
  ['sensor_id', I32],
  ['type', I32],
  ['timestamp', I32],
  ['temperature', F32],
  ['acceleration', VEC],
  ['gyro', VEC],
  ['magnetic', VEC],
  ['relative_humidity', F32],
  ['pressure', F32],
])

/** 레지스터에서 16비트 부호 있는 값 여러 개 읽기 */
function readWords(m: Machine, addr: number, reg: number, count: number): number[] | null {
  if (m.host.i2cWrite(addr, [reg], m.us) !== 0) return null
  const b = m.host.i2cRead(addr, count * 2, m.us)
  if (b.length < count * 2) return null
  m.us += count * 2 * 90
  return Array.from({ length: count }, (_, i) => {
    const v = (b[2 * i] << 8) | b[2 * i + 1]
    return v >= 0x8000 ? v - 0x10000 : v
  })
}

const adafruitMpuLib: Lib = (r) => {
  interface MpuObj {
    addr: number
    accelRange: number
    gyroRange: number
    ok: boolean
  }
  const ACCEL_LSB = [16384, 8192, 4096, 2048]
  const GYRO_LSB = [131, 65.5, 32.8, 16.4]
  const methods: Record<string, MethodDef> = {
    begin: {
      ret: BOOL,
      max: 3,
      call: (m, self, a) => {
        const o = self as MpuObj
        if (a.length) o.addr = Number(a[0]) & 0x7f
        m.host.i2cWrite(o.addr, [0x75], m.us)
        const who = m.host.i2cRead(o.addr, 1, m.us)[0]
        o.ok = who === 0x68 || who === 0x70 || who === 0x72
        if (o.ok) m.host.i2cWrite(o.addr, [0x6b, 0x01], m.us)
        m.us += 100000
        return o.ok ? 1 : 0
      },
    },
    setAccelerometerRange: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (m, self, a) => {
        const o = self as MpuObj
        o.accelRange = Number(a[0]) & 3
        m.host.i2cWrite(o.addr, [0x1c, o.accelRange << 3], m.us)
      },
    },
    getAccelerometerRange: { ret: U8, max: 0, call: (_m, self) => (self as MpuObj).accelRange },
    setGyroRange: {
      ret: VOID,
      min: 1,
      max: 1,
      call: (m, self, a) => {
        const o = self as MpuObj
        o.gyroRange = Number(a[0]) & 3
        m.host.i2cWrite(o.addr, [0x1b, o.gyroRange << 3], m.us)
      },
    },
    getGyroRange: { ret: U8, max: 0, call: (_m, self) => (self as MpuObj).gyroRange },
    setFilterBandwidth: { ret: VOID, min: 1, max: 1, call: () => undefined },
    getFilterBandwidth: { ret: U8, max: 0, call: () => 0 },
    setSampleRateDivisor: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setMotionDetectionThreshold: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setMotionDetectionDuration: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setInterruptPinLatch: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setInterruptPinPolarity: { ret: VOID, min: 1, max: 1, call: () => undefined },
    setMotionInterrupt: { ret: VOID, min: 1, max: 1, call: () => undefined },
    getMotionInterruptStatus: { ret: BOOL, max: 0, call: () => 0 },
    getEvent: {
      ret: BOOL,
      min: 3,
      max: 3,
      call: (m, self, a) => {
        const o = self as MpuObj
        const w = readWords(m, o.addr, 0x3b, 7)
        const [ae, ge, te] = a.map((x) => (x instanceof Ptr ? (x.get() as Record<string, Record<string, number> & number>) : null))
        if (!w || !ae || !ge || !te) return 0
        const g = 9.80665
        ae.acceleration.x = Math.fround((w[0] / ACCEL_LSB[o.accelRange]) * g)
        ae.acceleration.y = Math.fround((w[1] / ACCEL_LSB[o.accelRange]) * g)
        ae.acceleration.z = Math.fround((w[2] / ACCEL_LSB[o.accelRange]) * g)
        ;(te as unknown as Record<string, number>).temperature = Math.fround(w[3] / 340 + 36.53)
        const toRad = Math.PI / 180
        ge.gyro.x = Math.fround((w[4] / GYRO_LSB[o.gyroRange]) * toRad)
        ge.gyro.y = Math.fround((w[5] / GYRO_LSB[o.gyroRange]) * toRad)
        ge.gyro.z = Math.fround((w[6] / GYRO_LSB[o.gyroRange]) * toRad)
        const ts = Math.floor(m.us / 1000)
        for (const e of [ae, ge, te]) (e as unknown as Record<string, number>).timestamp = ts
        return 1
      },
    },
  }
  r.classes.set('Adafruit_MPU6050', { name: 'Adafruit_MPU6050', header: 'Adafruit_MPU6050.h', ctorMax: 0, construct: () => ({ addr: 0x68, accelRange: 0, gyroRange: 0, ok: false }), methods })
  r.types.set('sensors_event_t', EVENT)
  r.types.set('sensors_vec_t', VEC)
  for (const [k, v] of [
    ['MPU6050_RANGE_2_G', 0],
    ['MPU6050_RANGE_4_G', 1],
    ['MPU6050_RANGE_8_G', 2],
    ['MPU6050_RANGE_16_G', 3],
    ['MPU6050_RANGE_250_DEG', 0],
    ['MPU6050_RANGE_500_DEG', 1],
    ['MPU6050_RANGE_1000_DEG', 2],
    ['MPU6050_RANGE_2000_DEG', 3],
    ['MPU6050_BAND_260_HZ', 0],
    ['MPU6050_BAND_184_HZ', 1],
    ['MPU6050_BAND_94_HZ', 2],
    ['MPU6050_BAND_44_HZ', 3],
    ['MPU6050_BAND_21_HZ', 4],
    ['MPU6050_BAND_10_HZ', 5],
    ['MPU6050_BAND_5_HZ', 6],
    ['MPU6050_I2CADDR_DEFAULT', 0x68],
  ] as [string, number][])
    num(r, k, v)
}

const i2cdevMpuLib: Lib = (r) => {
  interface Mpu {
    addr: number
  }
  const words = (m: Machine, o: Mpu, reg: number, n: number) => readWords(m, o.addr, reg, n) ?? Array(n).fill(0)
  const outs = (a: unknown[], vals: number[]) => a.forEach((p, i) => (p instanceof Ptr ? p.set(vals[i]) : undefined))
  const methods: Record<string, MethodDef> = {
    initialize: {
      ret: VOID,
      max: 0,
      call: (m, self) => {
        const o = self as Mpu
        m.host.i2cWrite(o.addr, [0x6b, 0x01], m.us)
        m.host.i2cWrite(o.addr, [0x1b, 0x00], m.us)
        m.host.i2cWrite(o.addr, [0x1c, 0x00], m.us)
      },
    },
    testConnection: {
      ret: BOOL,
      max: 0,
      call: (m, self) => {
        const o = self as Mpu
        m.host.i2cWrite(o.addr, [0x75], m.us)
        const who = m.host.i2cRead(o.addr, 1, m.us)[0]
        return who === 0x68 ? 1 : 0
      },
    },
    getDeviceID: {
      ret: U8,
      max: 0,
      call: (m, self) => {
        const o = self as Mpu
        m.host.i2cWrite(o.addr, [0x75], m.us)
        return ((m.host.i2cRead(o.addr, 1, m.us)[0] ?? 0) >> 1) & 0x3f
      },
    },
    getMotion6: {
      ret: VOID,
      min: 6,
      max: 6,
      call: (m, self, a) => {
        const w = words(m, self as Mpu, 0x3b, 7)
        outs(a, [w[0], w[1], w[2], w[4], w[5], w[6]])
      },
    },
    getAcceleration: { ret: VOID, min: 3, max: 3, call: (m, self, a) => outs(a, words(m, self as Mpu, 0x3b, 3)) },
    getRotation: { ret: VOID, min: 3, max: 3, call: (m, self, a) => outs(a, words(m, self as Mpu, 0x43, 3)) },
    getAccelerationX: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x3b, 1)[0] },
    getAccelerationY: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x3d, 1)[0] },
    getAccelerationZ: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x3f, 1)[0] },
    getRotationX: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x43, 1)[0] },
    getRotationY: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x45, 1)[0] },
    getRotationZ: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x47, 1)[0] },
    getTemperature: { ret: I16, max: 0, call: (m, self) => words(m, self as Mpu, 0x41, 1)[0] },
    setFullScaleAccelRange: { ret: VOID, min: 1, max: 1, call: (m, self, a) => void m.host.i2cWrite((self as Mpu).addr, [0x1c, (Number(a[0]) & 3) << 3], m.us) },
    setFullScaleGyroRange: { ret: VOID, min: 1, max: 1, call: (m, self, a) => void m.host.i2cWrite((self as Mpu).addr, [0x1b, (Number(a[0]) & 3) << 3], m.us) },
  }
  for (const n of ['setXAccelOffset', 'setYAccelOffset', 'setZAccelOffset', 'setXGyroOffset', 'setYGyroOffset', 'setZGyroOffset', 'setDLPFMode', 'setRate', 'CalibrateAccel', 'CalibrateGyro', 'PrintActiveOffsets', 'setSleepEnabled'])
    methods[n] = { ret: VOID, max: 1, call: () => undefined }
  r.classes.set('MPU6050', { name: 'MPU6050', header: 'MPU6050.h', ctorMax: 1, construct: (_m, a) => ({ addr: a.length ? Number(a[0]) & 0x7f : 0x68 }), methods })
  for (const [k, v] of [['MPU6050_ACCEL_FS_2', 0], ['MPU6050_ACCEL_FS_4', 1], ['MPU6050_ACCEL_FS_8', 2], ['MPU6050_ACCEL_FS_16', 3], ['MPU6050_GYRO_FS_250', 0], ['MPU6050_GYRO_FS_500', 1], ['MPU6050_GYRO_FS_1000', 2], ['MPU6050_GYRO_FS_2000', 3], ['MPU6050_DEFAULT_ADDRESS', 0x68], ['MPU6050_ADDRESS_AD0_HIGH', 0x69]] as [string, number][])
    num(r, k, v)
}

// ------------------------------------------------------------ FastLED (기본 기능)

export const CRGB = struct('CRGB', [
  ['r', U8],
  ['g', U8],
  ['b', U8],
])

export function hsv2rgbRainbow(h: number, s: number, v: number): { r: number; g: number; b: number } {
  // FastLED 의 hsv2rgb_rainbow 를 단순화 (색상환을 8구간으로 나눠 선형 보간)
  h &= 255
  const region = Math.floor(h / 32)
  const f = (h % 32) * 8
  const table: [number, number, number][] = [
    [255, f / 3, 0],
    [255, 85 + f / 3, 0],
    [255 - f / 3, 170 + f / 3, 0],
    [170 - f * 0.66, 255, 0],
    [0, 255 - f / 2, f / 2],
    [0, 128 - f / 2, 128 + f / 2],
    [f / 2, 0, 255 - f / 2],
    [128 + f / 2, 0, 128 - f / 2],
  ]
  const [r0, g0, b0] = table[region]
  const sat = s / 255
  const val = v / 255
  const mix = (c: number) => Math.round((c * sat + 255 * (1 - sat)) * val)
  return { r: mix(r0), g: mix(g0), b: mix(b0) }
}

const fastLedLib: Lib = (r) => {
  r.types.set('CRGB', CRGB)
  const named: Record<string, number> = {
    Black: 0x000000, White: 0xffffff, Red: 0xff0000, Green: 0x008000, Lime: 0x00ff00, Blue: 0x0000ff, Yellow: 0xffff00, Cyan: 0x00ffff, Aqua: 0x00ffff, Magenta: 0xff00ff, Purple: 0x800080, Orange: 0xffa500, Pink: 0xffc0cb, Gray: 0x808080, Grey: 0x808080, Violet: 0xee82ee, Gold: 0xffd700, DarkRed: 0x8b0000, DarkGreen: 0x006400, DarkBlue: 0x00008b, Brown: 0xa52a2a, Navy: 0x000080, Teal: 0x008080, Maroon: 0x800000, Olive: 0x808000, Silver: 0xc0c0c0, Amethyst: 0x9966cc, HotPink: 0xff69b4, DeepPink: 0xff1493, SkyBlue: 0x87ceeb, OrangeRed: 0xff4500, Indigo: 0x4b0082, Coral: 0xff7f50, Chartreuse: 0x7fff00, Crimson: 0xdc143c, Turquoise: 0x40e0d0, Salmon: 0xfa8072, Tomato: 0xff6347,
  }
  for (const [k, v] of Object.entries(named)) r.constants.set(`CRGB::${k}`, { t: CRGB, v: { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 } })
  interface Fast {
    strips: { pin: string | null; leds: { r: number; g: number; b: number }[]; count: number }[]
    brightness: number
  }
  const show = (m: Machine, o: Fast) => {
    for (const s of o.strips) {
      m.us += 30 * s.count
      if (!s.pin) continue
      const k = o.brightness / 255
      const colors = s.leds.slice(0, s.count).map((c) => (Math.trunc(c.r * k) << 16) | (Math.trunc(c.g * k) << 8) | Math.trunc(c.b * k))
      m.host.pixels(s.pin)?.show(colors, m.us)
    }
  }
  const order = (name: string) => ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'].indexOf(name)
  const methods: Record<string, MethodDef> = {
    addLeds: {
      ret: VOID,
      min: 2,
      max: 3,
      call: (m, self, a) => {
        const o = self as Fast
        const targs = a[0] as (string | number | null)[]
        const pinNum = targs.find((x) => typeof x === 'number')
        const pin = typeof pinNum === 'number' ? m.host.pinId(pinNum) : null
        if (!pin) m.warn('FastLED.addLeds<칩, 핀, 색순서>(leds, 개수): 데이터 핀을 찾지 못했습니다')
        const leds = (a[1] instanceof Ptr ? (a[1].a as unknown[]) : (a[1] as unknown[])) as Fast['strips'][number]['leds']
        const colorOrder = targs.find((x) => typeof x === 'string' && order(x) >= 0) as string | undefined
        if (colorOrder && colorOrder !== 'GRB') m.warn(`WS2812B 의 색 순서는 GRB 입니다. ${colorOrder} 로 두면 색이 바뀌어 보입니다`)
        o.strips.push({ pin, leds, count: Number(a[a.length - 1]) })
        if (pin) m.host.pinMode(pin, 'OUTPUT', m.us)
      },
    },
    show: { ret: VOID, max: 1, call: (m, self) => show(m, self as Fast) },
    clear: {
      ret: VOID,
      max: 1,
      call: (m, self, a) => {
        const o = self as Fast
        for (const s of o.strips) for (const c of s.leds) Object.assign(c, { r: 0, g: 0, b: 0 })
        if (a.length && truthy(a[0])) show(m, o)
      },
    },
    setBrightness: { ret: VOID, min: 1, max: 1, call: (_m, self, a) => void ((self as Fast).brightness = Number(a[0]) & 255) },
    getBrightness: { ret: U8, max: 0, call: (_m, self) => (self as Fast).brightness },
    setMaxPowerInVoltsAndMilliamps: { ret: VOID, min: 2, max: 2, call: () => undefined },
    delay: {
      ret: VOID,
      min: 1,
      max: 1,
      gen: function* (m, self, a) {
        show(m, self as Fast)
        yield* waitUntil(m, m.us + Number(a[0]) * 1000)
        return undefined
      },
    },
  }
  r.classes.set('CFastLED', { name: 'CFastLED', header: 'FastLED.h', construct: () => ({}), methods })
  r.objects.set('FastLED', { cls: 'CFastLED', make: () => ({ strips: [], brightness: 255 }) satisfies Fast })
  for (const k of ['WS2812B', 'WS2812', 'WS2811', 'NEOPIXEL', 'SK6812', 'RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR']) r.constants.set(k, { t: U8, v: k })
  const asLeds = (v: unknown): { r: number; g: number; b: number }[] => (v instanceof Ptr ? ((v.a as unknown[]).slice(v.i as number) as never) : (v as never))
  r.functions.set('CHSV', { ret: CRGB, min: 3, max: 3, call: (_m, a) => hsv2rgbRainbow(Number(a[0]), Number(a[1]), Number(a[2])) })
  r.functions.set('fill_solid', {
    ret: VOID,
    min: 3,
    max: 3,
    call: (_m, a) => {
      const leds = asLeds(a[0])
      const c = a[2] as { r: number; g: number; b: number }
      for (let i = 0; i < Number(a[1]) && i < leds.length; i++) Object.assign(leds[i], { r: c.r, g: c.g, b: c.b })
    },
  })
  r.functions.set('fill_rainbow', {
    ret: VOID,
    min: 4,
    max: 4,
    call: (_m, a) => {
      const leds = asLeds(a[0])
      let hue = Number(a[2])
      for (let i = 0; i < Number(a[1]) && i < leds.length; i++) {
        Object.assign(leds[i], hsv2rgbRainbow(hue, 240, 255))
        hue = (hue + Number(a[3])) & 255
      }
    },
  })
  r.functions.set('fadeToBlackBy', {
    ret: VOID,
    min: 3,
    max: 3,
    call: (_m, a) => {
      const leds = asLeds(a[0])
      const k = (255 - (Number(a[2]) & 255)) / 255
      for (let i = 0; i < Number(a[1]) && i < leds.length; i++) Object.assign(leds[i], { r: Math.trunc(leds[i].r * k), g: Math.trunc(leds[i].g * k), b: Math.trunc(leds[i].b * k) })
    },
  })
  r.functions.set('random8', { ret: U8, max: 2, call: (m, a) => (a.length === 2 ? Number(a[0]) + Math.floor(m.host.random() * (Number(a[1]) - Number(a[0]))) : a.length === 1 ? Math.floor(m.host.random() * Number(a[0])) : Math.floor(m.host.random() * 256)) })
  r.functions.set('random16', { ret: U16, max: 2, call: (m, a) => (a.length === 2 ? Number(a[0]) + Math.floor(m.host.random() * (Number(a[1]) - Number(a[0]))) : a.length === 1 ? Math.floor(m.host.random() * Number(a[0])) : Math.floor(m.host.random() * 65536)) })
  r.functions.set('beatsin8', {
    ret: U8,
    min: 1,
    max: 3,
    call: (m, a) => {
      const lo = a.length > 1 ? Number(a[1]) : 0
      const hi = a.length > 2 ? Number(a[2]) : 255
      const s = (Math.sin((m.us / 60000000) * Number(a[0]) * 2 * Math.PI) + 1) / 2
      return Math.round(lo + (hi - lo) * s)
    },
  })
  num(r, 'NUM_LEDS_MAX', 1000, U16)
  void intOf
}

export const motorLibraries: Record<string, Lib> = {
  'Stepper.h': stepperLib,
  'AccelStepper.h': accelStepperLib,
  'Adafruit_PWMServoDriver.h': pcaLib,
  'Adafruit_MPU6050.h': adafruitMpuLib,
  'MPU6050.h': i2cdevMpuLib,
  'FastLED.h': fastLedLib,
}
