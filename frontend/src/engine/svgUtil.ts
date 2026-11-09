// SVG 문자열 생성 도우미 (외부 CSS 없이 단독으로 열리는 SVG 를 만든다)

export function esc(text: string | number): string {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export const FONT = "'Pretendard','Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',system-ui,sans-serif"
export const MONO = "ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace"

export const SIGNAL_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#9333ea', '#0891b2', '#ca8a04', '#db2777', '#4d7c0f']

export function svgDocument(width: number, height: number, body: string, title: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" font-family="${esc(FONT)}">` +
    `<title>${esc(title)}</title><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`
  )
}
