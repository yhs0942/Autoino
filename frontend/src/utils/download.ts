/** 브라우저에서 텍스트 파일을 내려받는다. */
export function downloadText(filename: string, content: string, mime: string) {
  downloadBlob(filename, new Blob([content], { type: mime }))
}

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 파일 이름에 쓸 수 없는 문자를 제거한다. */
export function safeFileName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'autoino'
}
