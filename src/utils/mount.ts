import type { Context } from '../context'
import { HTTPException } from '../http-exception'
import { GET_MATCH_RESULT } from '../request/constants'
import { getPattern, splitRoutingPath, tryDecode } from './url'

const countTrailingSlashes = (path: string): number => {
  let index = path.length
  while (index > 0 && path.charCodeAt(index - 1) === 47) {
    index--
  }
  return path.length - index
}

const getPathPrefixRange = (
  c: Context,
  pathPrefix: string,
  routePath: string
): { start: number; end: number } => {
  const path = c.req.path
  // Segments of the whole matched route, without the trailing wildcard.
  const routeSegments = splitRoutingPath(routePath.replace(/\/?\*$/, '')).filter(
    (segment) => segment !== ''
  )
  const prefixSegments = splitRoutingPath(pathPrefix).filter((segment) => segment !== '')
  // `pathPrefix` is the tail of the matched route. Segments in front of it
  // were added by grouping (e.g. `route()`) and are preserved: the range up
  // to `start` stays in the forwarded path, only the range up to `end` (the
  // mount's own prefix) is removed.
  const preservedCount = Math.max(routeSegments.length - prefixSegments.length, 0)
  const segments = routeSegments.length >= prefixSegments.length ? routeSegments : prefixSegments

  const matchResult = c.req[GET_MATCH_RESULT]
  const paramNames = new Set<string>()
  let length = 0
  let start = 0
  for (let i = 0; i < segments.length; i++) {
    if (i === preservedCount) {
      start = length
    }
    const part = segments[i]
    if (part[0] === ':' && part.endsWith('}?')) {
      throw new Error(
        `mount(): Optional regular expression parameters are not supported in "${routePath}".`
      )
    }
    const pattern = getPattern(part)
    if (pattern && pattern !== '*') {
      const name = pattern[1]
      if (paramNames.has(name)) {
        throw new Error(`mount(): Duplicate path parameter "${name}" in "${routePath}".`)
      }
      paramNames.add(name)
    }
    if (pattern && pattern !== '*' && pattern[2] !== true) {
      const value =
        matchResult.length === 2
          ? matchResult[1][matchResult[0][c.req.routeIndex][1][pattern[1]]]
          : matchResult[0][c.req.routeIndex][1][pattern[1]]
      length += value.length + 1
    } else if (pattern || part.endsWith('*')) {
      const end = path.indexOf('/', length + 1)
      length = end === -1 ? path.length : end
    } else {
      length += part.length + 1
    }
  }
  if (segments.length === preservedCount) {
    start = length
  }
  return { start, end: length }
}

export const createMountedRequest = (
  c: Context,
  pathPrefix: string,
  routePath: string
): Request => {
  if (/[^/]\*$/.test(routePath)) {
    throw new Error(`mount(): Wildcard must follow "/" in "${routePath}".`)
  }
  const { start, end } = getPathPrefixRange(c, pathPrefix, routePath)
  const rest = c.req.path.slice(end)
  // Segments before `start` (added by grouping such as `route()`) are kept,
  // only the mount's own prefix between `start` and `end` is removed.
  const path = c.req.path.slice(0, start) + rest || '/'
  // URL parsing removes dot segments, so the child would not see the path the parent routed.
  if (
    end > c.req.path.length ||
    (rest !== '' && rest[0] !== '/') ||
    /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(rest)
  ) {
    throw new HTTPException(400, { message: 'Invalid mounted path' })
  }

  const rawUrl = c.req.raw.url
  // The URL parser ends the authority at "?", "#" or "\", but routing reads the path from the first "/".
  if (/^[^/?#]*\/\/[^/?#\\]*[?#\\]/.test(rawUrl)) {
    throw new HTTPException(400, { message: 'Invalid mounted path' })
  }

  // URL parsing turns backslashes into slashes.
  const rawPathEnd = rawUrl.search(/[?#]/)
  const rawTrailingSlashes = countTrailingSlashes(
    rawPathEnd === -1 ? rawUrl : rawUrl.slice(0, rawPathEnd)
  )
  // A non-strict parent removed one slash. Forwarding the rest would let a
  // non-strict child remove another slash after the parent's authorization check.
  if (rawTrailingSlashes > 1 && countTrailingSlashes(c.req.path) === rawTrailingSlashes - 1) {
    throw new HTTPException(400, { message: 'Invalid mounted path' })
  }

  const url = new URL(rawUrl)
  // URL parsing treats backslashes as separators and removes tabs and line breaks.
  url.pathname = path.replace(/[\\\t\n\r]/g, encodeURIComponent)
  if (path.includes('%')) {
    try {
      decodeURI(path)
    } catch {
      // Invalid UTF-8 can prevent adjacent encoded characters from decoding.
      const reparsedPath = tryDecode(url.pathname, (value) =>
        decodeURI(value.replace(/%25/g, '%2525'))
      )
      if (reparsedPath !== path) {
        throw new HTTPException(400, { message: 'Invalid mounted path' })
      }
    }
  }
  return new Request(url, c.req.raw)
}
