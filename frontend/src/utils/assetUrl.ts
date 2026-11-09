/** public/ 폴더의 정적 파일 경로를 배포 base 경로에 맞게 변환한다. */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
}
