/**
 * Time-limited TURN credentials (plan 13 §4.5).
 *
 * The coturn long-term credential scheme: the username carries an expiry time,
 * the password is an HMAC-SHA1 of the username using a shared secret. A leaked
 * credential is therefore only useful until it expires, and never
 * exposes the server's secret.
 */
const TTL_SECONDS = 12 * 3600

export interface IceServerConfig {
  urls: string
  username?: string
  credential?: string
}

export function buildIceServers(userId: string): IceServerConfig[] {
  const servers: IceServerConfig[] = [{ urls: process.env.ENKAKU_STUN_URL ?? 'stun:stun.l.google.com:19302' }]
  const turnUrl = process.env.ENKAKU_TURN_URL
  const secret = process.env.ENKAKU_TURN_SECRET
  if (!turnUrl) return servers

  if (secret) {
    const expiry = Math.floor(Date.now() / 1000) + TTL_SECONDS
    const username = `${expiry}:${userId}`
    const credential = new Bun.CryptoHasher('sha1', secret).update(username).digest('base64')
    servers.push({ urls: turnUrl, username, credential })
  } else {
    // Static credentials: for trials only, never production.
    servers.push({
      urls: turnUrl,
      ...(process.env.ENKAKU_TURN_USER ? { username: process.env.ENKAKU_TURN_USER } : {}),
      ...(process.env.ENKAKU_TURN_PASSWORD ? { credential: process.env.ENKAKU_TURN_PASSWORD } : {}),
    })
  }
  return servers
}
