/** SVG 문자열을 PNG 로 변환한다 (브라우저 캔버스 사용). scale 은 해상도 배율 */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(img.naturalWidth * scale)
  canvas.height = Math.ceil(img.naturalHeight * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('캔버스를 사용할 수 없습니다.')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG 변환에 실패했습니다.'))), 'image/png'),
  )
}
