import { describe, expect, test } from 'bun:test'
import type { UiNode } from '@enkaku/sdk'
import {
  addressAfter,
  addressKind,
  assess,
  dnsComplete,
  dnsExpected,
  dnsSummary,
  isAddress,
  readDns,
  readWebrtc,
  sameOrg,
  sharesNetwork,
  settleStep,
  webrtcVerdicts,
} from './network-test'

/**
 * The trees below are TRANSCRIBED, not invented.
 *
 * Every node text and resource id here was read off a moto g06 through the
 * Inspect panel while browserleaks was open, in the order the panel listed
 * them — which is the order `dump()` returns. That is what makes these tests
 * worth anything: a fixture I made up would agree with whatever the parser
 * happens to do, and this file exists because the first version of the parser
 * disagreed with the real page in two places (`Local IP Address` followed by
 * the word "Local", and an empty `Public IP Address` followed by the next
 * section heading).
 *
 * When browserleaks changes its markup these will fail, and that is the point:
 * the alternative is a script that keeps returning plausible values from a
 * page it no longer understands.
 */

/** A leaf node — bounds and flags are irrelevant to every function under test. */
function n(text: string, resourceId = ''): UiNode {
  return {
    resourceId,
    text,
    desc: '',
    className: 'android.view.View',
    packageName: 'com.android.chrome',
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
    clickable: false,
    enabled: true,
    focused: false,
    index: 0,
    children: [],
  }
}

/** browserleaks.com/dns, fully loaded, transcribed 2026-08-06. */
const DNS_TREE: UiNode[] = [
  n('DNS Leak Test'),
  n('Incorrect network configurations or faulty VPN/proxy software can lead to your device sending DNS requests directly to your ISP’s server'),
  n('The DNS Leak Test is a tool used to determine which DNS servers your browser is using'),
  n('Your IP Address :'),
  n('IP Address'),
  n('182.6.75.84'),
  n('ISP'),
  n('PT Telekomunikasi Selular Indonesia'),
  n('Location'),
  n('Indonesia, Jagirsidosermo'),
  n('DNS Leak Test :'),
  n('Found 6 Servers, 2 ISP, 1 Location', 'dns-test'),
  n('ISP :'),
  n('IP Address :'),
  n('Datacamp Limited'),
  n('79.127.170.12'),
  n('Datacamp Limited'),
  n('79.127.170.15'),
  n('Datacamp Limited'),
  n('149.102.250.14'),
  n('DataCamp Limited'),
  n('2a02:6ea0:d16a::8'),
  n('DataCamp Limited'),
  n('2a02:6ea0:d16a::42'),
  n('DataCamp Limited'),
  n('2a02:6ea0:d16a::45'),
  n('', 'comments'),
  n('BrowserLeaks © 2011-2026'),
  n('All Rights Reserved'),
]

/** browserleaks.com/webrtc, fully loaded, transcribed 2026-08-06. */
const WEBRTC_TREE: UiNode[] = [
  n('WebRTC Leak Test'),
  n('Your Remote IP :'),
  n('IPv4 Address'),
  n('182.6.75.84'),
  n('IPv6 Address'),
  n('', 'client-ipv6'),
  n('WebRTC Support Detection :'),
  n('RTCPeerConnection'),
  n('True', 'rtc-peerconnection'),
  n('RTCDataChannel'),
  n('True', 'rtc-datachannel'),
  n('Your WebRTC IP :'),
  n('WebRTC Leak Test'),
  n('! WebRTC exposes your Local IP', 'rtc-leak'),
  n('✔ No Public IP Leak'),
  n('Local IP Address'),
  n('Local'),
  n('198.18.0.1'),
  n('Public IP Address'),
  n('', 'rtc-public'),
  n('Session Description :'),
  n('v=0\r\no=- 3278879668199104172 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0 1 2\r\n', 'rtc-sdp'),
  n('Media Devices :'),
  n('API Support'),
]

describe('the DNS leak page', () => {
  test('the your-IP block is read, and not confused with the table header below it', () => {
    const f = readDns(DNS_TREE)
    // Both "IP Address" and "IP Address :" exist on this page. The first is
    // the device's own address; the second is a column heading.
    expect(f.exitIp).toBe('182.6.75.84')
    expect(f.isp).toBe('PT Telekomunikasi Selular Indonesia')
    expect(f.location).toBe('Indonesia, Jagirsidosermo')
  })

  test('every resolver row is paired with its operator, IPv6 rows included', () => {
    const f = readDns(DNS_TREE)
    expect(f.servers).toEqual([
      { isp: 'Datacamp Limited', ip: '79.127.170.12' },
      { isp: 'Datacamp Limited', ip: '79.127.170.15' },
      { isp: 'Datacamp Limited', ip: '149.102.250.14' },
      { isp: 'DataCamp Limited', ip: '2a02:6ea0:d16a::8' },
      { isp: 'DataCamp Limited', ip: '2a02:6ea0:d16a::42' },
      { isp: 'DataCamp Limited', ip: '2a02:6ea0:d16a::45' },
    ])
  })

  test('the footer is not mistaken for another resolver row', () => {
    expect(readDns(DNS_TREE).servers.map((s) => s.ip)).not.toContain('BrowserLeaks © 2011-2026')
  })

  test('a cell holding a flag and an address is not filed as the operator', () => {
    // Observed on a real run: the operator column had not resolved, and the
    // address column rendered as one node reading "SG 79.127.170.12". The
    // parser filed that as the resolver's operator and the report then
    // described a company by that name. Unknown is the right answer.
    const unresolved: UiNode[] = [
      n('Found 3 Servers, 2 ISP, 1 Location', 'dns-test'),
      n('ISP :'),
      n('IP Address :'),
      n('SG 79.127.170.12'),
      n('79.127.170.12'),
      n('SG 2a02:6ea0:d16a::42'),
      n('2a02:6ea0:d16a::42'),
    ]
    expect(readDns(unresolved).servers).toEqual([
      { isp: null, ip: '79.127.170.12' },
      { isp: null, ip: '2a02:6ea0:d16a::42' },
    ])
  })

  test('an unknown operator never matches the exit ISP', () => {
    // The consequence of the bug above: a fabricated operator name could have
    // satisfied `sameOrg` and produced a leak finding out of nothing.
    expect(sameOrg(null, 'PT Telekomunikasi Selular Indonesia')).toBe(false)
  })

  test('the page states its own completion criteria, and they are used', () => {
    expect(dnsExpected('Found 6 Servers, 2 ISP, 1 Location')).toEqual({ servers: 6, isps: 2 })
    expect(dnsExpected('Found 1 Server, 1 ISP, 1 Location')).toEqual({ servers: 1, isps: 1 })
    expect(dnsExpected(null)).toBeNull()
  })

  test('addresses without their operators is not complete, however settled it looks', () => {
    // Three consecutive runs read every operator as unknown while the same
    // summary line said two of them were known. Nothing on the page was
    // changing, so waiting for it to stop changing ended the wait early; the
    // count the page prints is the only thing that knows better.
    const named = DNS_TREE
    const unnamed: UiNode[] = [
      n('Found 6 Servers, 2 ISP, 1 Location', 'dns-test'),
      n('ISP :'),
      n('IP Address :'),
      ...['79.127.170.12', '79.127.170.15', '149.102.250.14', '2a02:6ea0:d16a::8', '2a02:6ea0:d16a::42', '2a02:6ea0:d16a::45'].map(
        (ip) => n(ip),
      ),
    ]
    expect(readDns(unnamed).servers).toHaveLength(6)
    expect(dnsComplete(unnamed)).toBe(false)
    expect(dnsComplete(named)).toBe(true)
  })

  test('a table with fewer rows than promised is not complete', () => {
    const short: UiNode[] = [
      n('Found 6 Servers, 2 ISP, 1 Location', 'dns-test'),
      n('IP Address :'),
      n('Datacamp Limited'),
      n('79.127.170.12'),
      n('Cloudflare'),
      n('1.1.1.1'),
    ]
    expect(dnsComplete(short)).toBe(false)
  })

  test('a half-loaded table is not reported as finished', () => {
    // The completion line is what `awaitPage` waits on. Without it the table
    // below is still filling, and a dump taken here returns a partial server
    // list that looks exactly as trustworthy as a complete one.
    const partial = DNS_TREE.filter((x) => x.resourceId !== 'dns-test')
    expect(dnsSummary(partial)).toBeNull()
    expect(dnsSummary(DNS_TREE)).toBe('Found 6 Servers, 2 ISP, 1 Location')
  })
})

describe('the WebRTC leak page', () => {
  test('the local address is read past the decorative cell that precedes it', () => {
    // `Local IP Address` is followed by an Image whose text is "Local".
    // Taking "the next text" returns the word Local.
    expect(addressAfter(WEBRTC_TREE, 'Local IP Address', ['Public IP Address'])).toBe('198.18.0.1')
    expect(readWebrtc(WEBRTC_TREE).localIps).toContain('198.18.0.1')
  })

  test('an empty public-IP field reads as absent, not as the next heading', () => {
    // The regression this file was written for: with no leak the field is
    // empty, and the next text on the page is "Session Description :".
    expect(readWebrtc(WEBRTC_TREE).publicIp).toBeNull()
  })

  test('SDP placeholders are not reported as exposed addresses', () => {
    expect(readWebrtc(WEBRTC_TREE).localIps).not.toContain('127.0.0.1')
    expect(readWebrtc(WEBRTC_TREE).localIps).not.toContain('0.0.0.0')
  })

  test('the remote address is the one the page was reached from', () => {
    expect(readWebrtc(WEBRTC_TREE).remoteIp).toBe('182.6.75.84')
  })

  test('the verdict line is what marks the test finished', () => {
    expect(webrtcVerdicts(WEBRTC_TREE)).toEqual(['! WebRTC exposes your Local IP', '✔ No Public IP Leak'])
    // Before the probes return, neither line exists — and the address fields
    // are empty, which is indistinguishable from "no leak".
    const early = WEBRTC_TREE.filter((x) => !/Leak|expose/i.test(x.text) || x.text === 'WebRTC Leak Test')
    expect(webrtcVerdicts(early)).toEqual([])
  })
})

describe('address classification', () => {
  test('198.18.0.0/15 is a tunnel interface, not a LAN address', () => {
    expect(addressKind('198.18.0.1')).toBe('tunnel')
    expect(addressKind('198.19.255.254')).toBe('tunnel')
    // The neighbours are ordinary public space and must not be swept in.
    expect(addressKind('198.17.0.1')).toBe('public')
    expect(addressKind('198.20.0.1')).toBe('public')
  })

  test('the usual private ranges are recognised', () => {
    expect(addressKind('192.168.1.5')).toBe('private')
    expect(addressKind('10.0.0.1')).toBe('private')
    expect(addressKind('172.16.0.1')).toBe('private')
    expect(addressKind('172.32.0.1')).toBe('public')
    expect(addressKind('100.64.0.1')).toBe('private')
    expect(addressKind('182.6.75.84')).toBe('public')
  })

  test('compressed IPv6 counts as an address; prose does not', () => {
    expect(isAddress('2a02:6ea0:d16a::45')).toBe(true)
    expect(isAddress('182.6.75.84')).toBe(true)
    expect(isAddress('999.1.1.1')).toBe(false)
    expect(isAddress('Datacamp Limited')).toBe(false)
    expect(isAddress('Session Description :')).toBe(false)
  })
})

describe('operator names', () => {
  test('the same company survives case and legal-form differences', () => {
    expect(sameOrg('Datacamp Limited', 'DataCamp Limited')).toBe(true)
    expect(sameOrg('PT Telekomunikasi Selular Indonesia', 'Telekomunikasi Selular Indonesia')).toBe(true)
  })

  test('different companies are not merged', () => {
    expect(sameOrg('Datacamp Limited', 'PT Telekomunikasi Selular Indonesia')).toBe(false)
    // Stripping every legal suffix must not reduce a name to nothing and then
    // match everything: "Co" alone normalises to the empty string.
    expect(sameOrg('Co', 'Ltd')).toBe(false)
  })
})

describe('resolver network matching', () => {
  test('a resolver in the exit address block is recognised without any operator name', () => {
    expect(sharesNetwork('182.6.99.1', '182.6.75.84')).toBe(true)
    expect(sharesNetwork('79.127.170.12', '182.6.75.84')).toBe(false)
  })

  test('IPv6 and missing values never match', () => {
    expect(sharesNetwork('2a02:6ea0:d16a::42', '182.6.75.84')).toBe(false)
    expect(sharesNetwork(null, '182.6.75.84')).toBe(false)
    expect(sharesNetwork('182.6.75.84', null)).toBe(false)
  })

  test('a first octet in common is not enough', () => {
    // 182.x is a large block spanning many operators; matching on it alone
    // would report a leak for any two Asian addresses.
    expect(sharesNetwork('182.99.1.1', '182.6.75.84')).toBe(false)
  })
})

describe('the assessment', () => {
  const dns = readDns(DNS_TREE)
  const webrtc = readWebrtc(WEBRTC_TREE)

  test('the observed device is fingerprintable, not leaking', () => {
    const { verdict, findings } = assess({ whoer: null, dns, webrtc })
    expect(verdict).toBe('fingerprintable')
    expect(findings.map((f) => f.id)).toContain('webrtc-tunnel-interface-exposed')
    expect(findings.map((f) => f.id)).toContain('dns-resolver-third-party')
    expect(findings.map((f) => f.id)).not.toContain('webrtc-public-ip-leak')
  })

  test('a public address from WebRTC that differs from the exit address is a leak', () => {
    const leaking = { ...webrtc, publicIp: '203.0.113.9' }
    const { verdict, findings } = assess({ whoer: null, dns, webrtc: leaking })
    expect(verdict).toBe('leaking')
    expect(findings.find((f) => f.id === 'webrtc-public-ip-leak')?.detail).toContain('203.0.113.9')
  })

  test('sites disagreeing about the exit address is a leak', () => {
    const { findings } = assess({
      whoer: { exitIp: '1.2.3.4', exitIpSource: 'inline', isp: null, dns: null, hostname: null, os: null, browser: null },
      dns,
      webrtc,
    })
    expect(findings.map((f) => f.id)).toContain('exit-ip-disagreement')
  })

  test('DNS on the exit network is caught even when no operator name resolved', () => {
    // Four runs in a row read every operator as unknown. A check that needs
    // those names is a check that does not run.
    const nameless = { ...dns, servers: [{ isp: null, ip: '182.6.99.1' }] }
    const { findings } = assess({ whoer: null, dns: nameless, webrtc })
    expect(findings.map((f) => f.id)).toContain('dns-resolver-on-exit-network')
  })

  test('a tunnel that is up while its own ISP answers DNS is called out', () => {
    // The inference no single page makes: WebRTC sees a tunnel interface, yet
    // the resolvers belong to the same operator as the exit address — so the
    // interface exists and the traffic is going around it.
    const bypassed = {
      ...dns,
      servers: [{ isp: 'PT Telekomunikasi Selular Indonesia', ip: '10.1.1.1' }],
    }
    const { verdict, findings } = assess({ whoer: null, dns: bypassed, webrtc })
    expect(findings.map((f) => f.id)).toContain('tunnel-present-but-bypassed')
    expect(verdict).toBe('leaking')
  })

  test('nothing measured means unknown, never clean', () => {
    expect(assess({ whoer: null, dns: null, webrtc: null }).verdict).toBe('unknown')
  })
})

describe('settling', () => {
  test('a reading only counts once it has repeated', () => {
    // The rule that stops the script reading a test that is still running.
    let s = { fp: null as string | null, count: 0 }
    s = settleStep(s, 'Found 1 Server|@1.1.1.1', 3)
    expect(s.done).toBe(false)
    s = settleStep(s, 'Found 3 Servers|@1.1.1.1,@2.2.2.2,@3.3.3.3', 3)
    expect(s.done).toBe(false)
    expect(s.count).toBe(1) // changed, so the streak restarted
  })

  test('a value that stops moving ends the wait', () => {
    let s = { fp: null as string | null, count: 0 }
    for (const _ of [1, 2]) s = settleStep(s, 'stable', 3)
    expect(s.done).toBe(false)
    s = settleStep(s, 'stable', 3)
    expect(s.done).toBe(true)
  })

  test('a late operator name restarts the streak even when the count holds', () => {
    // browserleaks resolves operator names on a second lookup, so the row
    // count can sit still while the names are still arriving. Fingerprinting
    // the count alone would have called this settled.
    let s = { fp: null as string | null, count: 0 }
    s = settleStep(s, 'Found 1 Server|?@79.127.170.15', 3)
    s = settleStep(s, 'Found 1 Server|?@79.127.170.15', 3)
    expect(s.count).toBe(2)
    s = settleStep(s, 'Found 1 Server|Datacamp Limited@79.127.170.15', 3)
    expect(s.count).toBe(1)
    expect(s.done).toBe(false)
  })
})
