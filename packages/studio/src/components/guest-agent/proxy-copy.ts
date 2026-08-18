/**
 * The sentences plan 114 turns on, declared once (plan 114 §3.1 rule 1, risk 1).
 *
 * Step 114.6 wrote these inline in `NetworkRouteForm`'s mode selector and
 * `HttpProxyFields`' advisory banner, which was right while there was exactly
 * one screen. Step 114.8 added a second one — `BulkProxyDialog`, which asks the
 * same question about N devices at once — and a second copy of a sentence whose
 * whole job is to stop an operator believing HTTP proxy captures their traffic
 * is a sentence that will eventually be softened in one place and not the other.
 * Risk 1's mitigation is "defence in three independent places"; three copies of
 * the WORDING is not one of the three, it is the failure mode.
 *
 * A `.ts` module, not `.tsx`: strings only, so nothing here pulls a component
 * into a bundle that only wanted a sentence.
 */

/**
 * HTTP proxy, at the point of choice. Never the word "advisory" — that is a
 * word an operator has to already know (§3.1 rule 1).
 */
export const HTTP_MODE_DESCRIPTION =
  'Apps can ignore this. WebView and many HTTP libraries use it; an app with its own networking does not, and nothing on the phone stops it.'

/** VPN, at the point of choice. The other half of the pair, and the half that makes the first one legible. */
export const VPN_MODE_DESCRIPTION = 'Apps cannot opt out of this. Needs the Enkaku guest agent installed on the phone.'

/**
 * The permanent sentence under HTTP mode (plan 114 §3.5) — rendered
 * unconditionally, not on hover and not only once something has gone wrong.
 *
 * `health` is `unverified` forever for both HTTP rungs and that is the correct
 * answer rather than a gap to close later: an egress probe has to run ON the
 * device to say anything, and the only device-side vehicle that honours this
 * setting would prove no more than "a client that honours it can reach the
 * proxy" — never that any app under test did. So the screen says WHICH fact is
 * missing instead of leaving `unverified` to be read as "still loading".
 */
export const HTTP_PROXY_ADVISORY =
  'A proxy is set on this phone. Apps that honour the system proxy will use it; an app with its own networking can ignore it, and nothing here can tell you which did. For traffic an app cannot escape, use VPN mode.'
