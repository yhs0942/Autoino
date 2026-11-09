// 사용자별 화면 설정 (배선 모양 등). 저장할 수 없는 환경에서도 앱은 정상 동작해야 한다.

const PREFIX = 'autoino:pref:'

export function loadPreference(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key)
  } catch {
    return null
  }
}

export function savePreference(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value)
  } catch {
    // 무시: 다음 방문 때 기본값을 사용한다
  }
}
