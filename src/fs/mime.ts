/**
 * 最小 MIME / 文本判定辅助。文件管理器只需要一小部分常见类型，
 * 不值得为此引入依赖；未知扩展一律按二进制流处理。
 * @module dsh-admin/fs/mime
 */

/** 扩展名（小写、不含点）→ Content-Type。 */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/json; charset=utf-8',
  geojson: 'application/json; charset=utf-8',
  yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8',
  toml: 'text/plain; charset=utf-8',
  ini: 'text/plain; charset=utf-8',
  conf: 'text/plain; charset=utf-8',
  env: 'text/plain; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  tsx: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xml: 'text/xml; charset=utf-8',
  svg: 'image/svg+xml',
  sh: 'text/plain; charset=utf-8',
  bash: 'text/plain; charset=utf-8',
  zsh: 'text/plain; charset=utf-8',
  bat: 'text/plain; charset=utf-8',
  ps1: 'text/plain; charset=utf-8',
  py: 'text/plain; charset=utf-8',
  rb: 'text/plain; charset=utf-8',
  go: 'text/plain; charset=utf-8',
  rs: 'text/plain; charset=utf-8',
  c: 'text/plain; charset=utf-8',
  h: 'text/plain; charset=utf-8',
  cpp: 'text/plain; charset=utf-8',
  hpp: 'text/plain; charset=utf-8',
  java: 'text/plain; charset=utf-8',
  kt: 'text/plain; charset=utf-8',
  swift: 'text/plain; charset=utf-8',
  php: 'text/plain; charset=utf-8',
  sql: 'text/plain; charset=utf-8',
  graphql: 'text/plain; charset=utf-8',
  dockerfile: 'text/plain; charset=utf-8',
  gitignore: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
}

/** 按扩展名取 Content-Type；未知类型回退到八位字节流。 */
export function lookupMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

/**
 * 扩展名是否属于「大概率是文本」的类型。文本预览先看这里，
 * 命中就直接按 UTF-8 读；未命中再做 NUL 嗅探兜底。
 */
export function isTextByExtension(name: string): boolean {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const mime = MIME_BY_EXT[ext] ?? ''
  return mime.startsWith('text/') || mime.startsWith('application/json')
}

/**
 * 嗅探缓冲区是否为二进制：前若干字节内出现 NUL 即判定为二进制。
 * （UTF-8 / UTF-16 文本不会包含 NUL 连续段以外的情形——UTF-16 会被
 * 误判，但对预览场景足够，且 UTF-16 文本极罕见。）
 */
export function sniffIsBinary(buf: Buffer): boolean {
  return buf.includes(0)
}
