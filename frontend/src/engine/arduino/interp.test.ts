import { describe, expect, it } from 'vitest'
import type { BoardInfo } from './core'
import { Program } from './program'
import { FakeHost } from './testHost'

const UNO: BoardInfo = { kind: 'uno', core: 'avr' }
const ESP: BoardInfo = { kind: 'esp32', core: 'esp32' }

function run(src: string, ms = 100, board = UNO, host = new FakeHost(board.core)) {
  const p = new Program(src, host, board)
  if (!p.ok) throw new Error(p.errors.map((e) => `${e.line}: ${e.message}`).join('\n'))
  for (let t = 0; t <= ms; t += 10) p.run(t * 1000)
  return { p, host, out: host.serialPort.text() }
}

const once = (body: string, globals = '') => run(`${globals}\nvoid setup(){ Serial.begin(9600); ${body} }\nvoid loop(){}`).out

describe('Arduino 인터프리터: 언어', () => {
  it('Serial.print 의 숫자·실수·문자 표기', () => {
    expect(once('Serial.println(42); Serial.println(3.14159); Serial.println(2.5, 3); Serial.println(255, HEX); Serial.println(5, BIN); Serial.print(\'A\'); Serial.println((byte)65);')).toBe('42\r\n3.14\r\n2.500\r\nFF\r\n101\r\nA65\r\n')
  })

  it('AVR int 는 16비트로 넘친다', () => {
    expect(once('int a = 30000; a = a + 10000; Serial.println(a); long b = 1000L * 60; Serial.println(b); int c = 1000 * 60; Serial.println(c);')).toBe('-25536\r\n60000\r\n-5536\r\n')
  })

  it('ESP32 int 는 32비트', () => {
    const { out } = run('void setup(){ Serial.begin(115200); int a = 30000; a = a + 10000; Serial.println(a); } void loop(){}', 10, ESP)
    expect(out).toBe('40000\r\n')
  })

  it('정수 나눗셈·나머지, 부호 없는 비교', () => {
    expect(once('Serial.println(7 / 2); Serial.println(-7 / 2); Serial.println(-7 % 3); Serial.println(7.0 / 2); unsigned long t = 5; Serial.println(t - 10 > 100);')).toBe('3\r\n-3\r\n-1\r\n3.50\r\n1\r\n')
  })

  it('함수·재귀·참조 매개변수·기본값', () => {
    const g = 'int fact(int n){ return n <= 1 ? 1 : n * fact(n - 1); } void twice(int &x){ x *= 2; } int add(int a, int b = 10){ return a + b; }'
    expect(once('long f = fact(7); Serial.println(f); int v = 5; twice(v); Serial.println(v); Serial.println(add(1)); Serial.println(add(1, 2));', g)).toBe('5040\r\n10\r\n11\r\n3\r\n')
  })

  it('배열·구조체·열거형·switch', () => {
    const g = 'struct P { int x; int y; }; enum Mode { IDLE, RUN = 5, STOP }; int arr[] = {3, 1, 4, 1, 5};'
    const body = `int s = 0; for (int i = 0; i < sizeof(arr) / sizeof(arr[0]); i++) s += arr[i]; Serial.println(s);
      P p = {2, 3}; P q = p; q.x = 9; Serial.println(p.x + q.x);
      Mode m = RUN; switch (m) { case IDLE: Serial.println("idle"); break; case RUN: Serial.println("run"); case STOP: Serial.println("stop"); break; default: Serial.println("?"); }
      Serial.println(STOP);`
    expect(once(body, g)).toBe('14\r\n11\r\nrun\r\nstop\r\n6\r\n')
  })

  it('String 연결·메서드', () => {
    const body = `String s = "Temp: "; s += 23; s = s + " C"; Serial.println(s); Serial.println(s.length()); String n = "  42abc "; n.trim(); Serial.println(n.toInt() + 1);
      Serial.println(s.substring(0, 4)); Serial.println(s.indexOf("23")); String f = String(3.14159, 3); Serial.println(f); Serial.println(String(255, HEX)); if (s.startsWith("Temp")) Serial.println("ok");`
    expect(once(body)).toBe('Temp: 23 C\r\n10\r\n43\r\nTemp\r\n6\r\n3.142\r\nff\r\nok\r\n')
  })

  it('char 배열·sprintf·strcmp·dtostrf (AVR 의 %f 는 너비만큼 띄운 ?)', () => {
    const { out, host } = run(`char buf[32]; void setup(){ Serial.begin(9600); sprintf(buf, "x=%d y=%05.1f %s", 12, 3.5, "hi"); Serial.println(buf); char t[10]; dtostrf(3.14159, 6, 2, t); Serial.println(t); Serial.println(strcmp("abc", "abd") < 0); strcpy(buf, "hello"); strcat(buf, "!"); Serial.println(buf); Serial.println(strlen(buf)); } void loop(){}`)
    expect(out).toBe('x=12 y=    ? hi\r\n  3.14\r\n1\r\nhello!\r\n6\r\n')
    expect(host.warnings.some((w) => w.includes('%f'))).toBe(true)
  })

  it('#define·함수형 매크로·#if', () => {
    const src = `#define LED 13
#define SQ(x) ((x) * (x))
#if defined(__AVR__)
#define WHO "avr"
#else
#define WHO "other"
#endif
void setup(){ Serial.begin(9600); Serial.println(SQ(LED + 1)); Serial.println(WHO); } void loop(){}`
    expect(run(src).out).toBe('196\r\navr\r\n')
  })

  it('millis 와 delay 는 가상 시간으로 흐른다', () => {
    const { out } = run('void setup(){ Serial.begin(9600); } void loop(){ Serial.println(millis()); delay(25); }', 80)
    expect(out.trim().split('\r\n').map(Number)).toEqual([0, 25, 50, 75])
  })

  it('blink: digitalWrite 기록이 1초 간격', () => {
    const { host } = run('void setup(){ pinMode(13, OUTPUT); } void loop(){ digitalWrite(13, HIGH); delay(1000); digitalWrite(13, LOW); delay(1000); }', 4500)
    const times = host.writes.filter((w) => w[1] === 'D13').map((w) => [Math.round(w[0] / 1000), w[2]])
    expect(times.slice(0, 5)).toEqual([[0, true], [1000, false], [2000, true], [3000, false], [4000, true]])
  })

  it('while(true) 도 멈추지 않고 예산마다 양보한다', () => {
    const { p } = run('int n = 0; void setup(){ } void loop(){ while (true) { n++; } }', 50)
    expect(p.state).toBe('running')
  })

  it('INPUT_PULLUP 버튼과 인터럽트', () => {
    const host = new FakeHost()
    const p = new Program('volatile int count = 0; void onPress(){ count++; } void setup(){ Serial.begin(9600); pinMode(2, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(2), onPress, FALLING); } void loop(){ static int shown = -1; if (count != shown) { shown = count; Serial.println(count); } delay(10); }', host, UNO)
    expect(p.errors).toEqual([])
    p.run(20000)
    host.setInput('D2', false)
    p.run(40000)
    host.setInput('D2', true)
    p.run(60000)
    host.setInput('D2', false)
    p.run(80000)
    expect(host.serialPort.text()).toBe('0\r\n1\r\n2\r\n')
  })

  it('Serial 입력: parseInt 뒤에 남은 줄바꿈은 1초 기다린 뒤 0 이 된다 (실제 보드와 같음)', () => {
    const host = new FakeHost()
    const p = new Program('void setup(){ Serial.begin(9600); } void loop(){ if (Serial.available()) { int v = Serial.parseInt(); Serial.println(v * 2); } }', host, UNO)
    p.run(10000)
    host.serialPort.send('21\n', 10000)
    for (let t = 20; t <= 1500; t += 20) p.run(t * 1000)
    expect(host.serialPort.text()).toBe('42\r\n0\r\n')
  })

  it('컴파일 오류: 줄 번호와 이유', () => {
    const p = new Program('void setup() {\n  pinMode(13, OUTPUT)\n}\nvoid loop() {}', new FakeHost(), UNO)
    expect(p.errors[0].line).toBe(2)
    expect(p.errors[0].message).toContain(';')
    const q = new Program('void setup() {\n  ledPin = 3;\n}\nvoid loop() {}', new FakeHost(), UNO)
    expect(q.errors[0]).toMatchObject({ line: 2 })
    expect(q.errors[0].message).toContain('ledPin')
    const r = new Program('#include <WiFi.h>\nvoid setup(){} void loop(){}', new FakeHost(), UNO)
    expect(r.errors[0].message).toContain('Wi-Fi')
    const s = new Program('void setup(){ Servo s; } void loop(){}', new FakeHost(), UNO)
    expect(s.errors[0].message).toContain('Servo')
  })

  it('실행 오류: 0 으로 나누기, 배열 범위', () => {
    const a = run('void setup(){ int z = 0; int x = 5 / z; } void loop(){}', 10)
    expect(a.p.state).toBe('error')
    expect(a.p.fault?.message).toContain('0 으로')
    const b = run('int arr[3]; void setup(){\n for (int i = 0; i <= 3; i++) arr[i] = i;\n} void loop(){}', 10)
    expect(b.p.fault).toMatchObject({ line: 2 })
    expect(b.p.fault?.message).toContain('arr[3]')
  })

  it('포인터: 주소 넘기기, 배열 포인터', () => {
    const g = 'void setTo(int *p, int v){ *p = v; } int sum(int *a, int n){ int s = 0; for (int i = 0; i < n; i++) s += a[i]; return s; } int data[4] = {1, 2, 3, 4};'
    expect(once('int x = 1; setTo(&x, 7); Serial.println(x); Serial.println(sum(data, 4)); int *q = data; q++; Serial.println(*q);', g)).toBe('7\r\n10\r\n2\r\n')
  })

  it('map·constrain·random·bitRead', () => {
    expect(once('Serial.println(map(512, 0, 1023, 0, 255)); Serial.println(constrain(300, 0, 255)); Serial.println(bitRead(5, 2)); byte b = 0; bitSet(b, 3); Serial.println(b); randomSeed(42); long r = random(10); Serial.println(r >= 0 && r < 10);')).toBe('127\r\n255\r\n1\r\n8\r\n1\r\n')
  })
})
